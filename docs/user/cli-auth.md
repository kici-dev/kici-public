---
title: CLI authentication
description: Authenticate the KiCI CLI with browser OAuth, device flow, or API key paste
---

The KiCI CLI supports three authentication methods: browser-based OAuth (default), device authorization flow (for headless environments), and API key paste (for CI/CD pipelines).

## Authentication methods

### Browser OAuth (default)

The default `kici login` flow:

1. Opens your default browser to the KiCI identity provider
2. You authenticate in the browser
3. The CLI receives a token via localhost callback
4. A personal access token (PAT) is created and stored locally

```bash
kici login
```

The CLI auto-detects headless environments (SSH sessions, CI runners) and switches to device flow automatically.

### Device flow (headless)

For environments without a browser (SSH, remote servers):

```bash
kici login --device
```

This displays a URL and a code. Open the URL on any device, enter the code, and authenticate. The CLI polls for completion.

### API key paste

For CI/CD pipelines and automated environments, paste an API key directly:

```bash
kici login --token kici_sk_abc123...
```

The API key (starts with `kici_sk_`) is passed directly as the flag value and stored in your local config file.

## kici logout

Revoke your PAT and clear local authentication:

```bash
kici logout
```

This:

1. Revokes the PAT on the server (preventing further use)
2. Clears auth fields from the local config file
3. Preserves non-auth settings (active org, default clusters, Platform endpoint)

## Organization management

### List organizations

```bash
kici org list
```

Shows all organizations you belong to, with your role in each. The active organization is marked with an asterisk.

### Switch active organization

```bash
kici org use <name-or-id>
```

Name matching is case-insensitive. You can also use the organization ID directly.

The active organization is both the scope for org-scoped commands (`kici runs list`, `kici diagnostics`, `kici secrets list`, …) **and** the default target for `kici run remote`. After `kici login` and `kici org use <org>`, `kici run remote` dispatches to that org through the Platform — that is the complete path to a remote run. Override the target for a single run with `kici run remote --org <id>`.

If an organization has more than one connected orchestrator cluster, set its default cluster once with `kici orchestrators use <name>` (list them with `kici orchestrators list`). `kici run remote` then targets that cluster unless you pass `--orchestrator <name>`. With a single connected orchestrator the cluster is selected automatically.

### Show current organization

```bash
kici org current
```

Displays the currently active organization name and ID.

## Auth status

`kici org current` shows your current login state and active organization:

```bash
kici org current
```

It reports whether you are logged in and which organization is active. PAT
expiry and the full list of your tokens are managed from the dashboard (see
"Dashboard management" below).

## Personal access tokens

Personal access tokens (PATs) are created automatically when you log in via OAuth. You can also create and manage PATs through the dashboard.

### How PATs work

- **User-scoped**: PATs work across all organizations you belong to
- **120-day default expiry**: Configurable when creating from the dashboard
- **Named per machine**: Each login creates a PAT named after the machine hostname
- **Permission inheritance**: PATs inherit your effective role permissions in each org

### PATs vs API keys

|            | Personal access tokens | API keys        |
| ---------- | ---------------------- | --------------- |
| Scope      | User (cross-org)       | Organization    |
| Prefix     | `kici_pat_`            | `kici_sk_`      |
| Created by | CLI login or dashboard | Dashboard       |
| Expiry     | 120 days (default)     | No expiry       |
| Use case   | Developer CLI access   | CI/CD pipelines |

### Dashboard management

Create, view, and revoke PATs from the dashboard:

1. Click your avatar in the sidebar
2. Select **Account settings**
3. Navigate to the **Personal access tokens** tab

From here you can:

- Create PATs with custom names and expiry periods
- View active PATs with their prefixes and expiry dates
- Revoke PATs that are no longer needed

## Reaching the Platform API directly

The Platform exposes a versioned REST API under `/api/v1/*`. The same endpoints back the dashboard SPA, the `kici` CLI, and any third-party automation. There is no separate "public" surface — the dashboard's API is the API.

### Base URL

| Deployment  | Base URL pattern                                                          |
| ----------- | ------------------------------------------------------------------------- |
| KiCI Cloud  | `https://<your-platform-host>/api/v1/`                                    |
| Self-hosted | `https://<orchestrator-host>/<deployment-slug>/api/v1/` (slug is optional |
|             | — `KICI_BASE_PATH` may add a prefix when the Platform is reverse-proxied) |

`/api/v1/*` requires authentication (see below). `/health`, `/metrics`, and `/ws` (WebSocket) sit outside that prefix and have their own access posture (`/metrics` is meant for Prometheus scrape, not public exposure).

### Authentication

Every request to `/api/v1/*` carries an `Authorization: Bearer <token>` header. The Platform routes on the prefix:

| Prefix      | Token type                    | Created via                             | Scope            |
| ----------- | ----------------------------- | --------------------------------------- | ---------------- |
| `kici_pat_` | Personal access token         | `kici login` or dashboard               | User (cross-org) |
| `kici_sk_`  | User API key                  | Dashboard → Settings → API keys         | Org              |
| `kici_sa_`  | Service account key           | Dashboard → Settings → Service accounts | Org              |
| (other)     | OIDC JWT or opaque OIDC token | OIDC login (browser SPA)                | User (cross-org) |

JWT and opaque OIDC tokens are validated against the configured OIDC issuer (JWKS for JWTs, the issuer's UserInfo endpoint for opaque ones). All `kici_*` tokens are validated by SHA-256 hash lookup against the Platform DB. See [RBAC: authentication methods](../architecture/security/rbac.md#authentication-methods) for the full model.

> **Note:** `kici_ok_` keys are **not** for the HTTP API — they authenticate orchestrator-to-Platform WebSocket connections only. Use `kici_sk_` (or `kici_pat_`) for HTTP calls.

### Permissions

Tokens authenticate; RBAC authorizes. Every org-scoped route runs `orgContextMiddleware` (verifies you are a member of the target org) followed by `requirePermission(resource, level)`. The 17 resources and 5 levels are documented in [RBAC](../architecture/security/rbac.md#permission-model). User API keys carry their own permission matrix bounded above by the creator's effective permissions; PATs inherit the user's role permissions (or are capped further by their `scopes` field).

### Configurable surfaces

The dashboard is a browser SPA on top of the same `/api/v1/*` surface, so anything you can configure in the dashboard you can configure over HTTP. The mounted route groups include:

- **Auth & identity:** `/cli/exchange-token`, `/pats`, `/user`, `/identity-links`, `/github-oauth`, `/invites`, `/invites/pending`, `/invites/:inviteId/{accept,decline}`
- **Org & membership:** `/orgs`, `/orgs/:customerId`, `/orgs/:customerId/{members,roles,api-keys,orchestrator-keys,service-accounts,billing,trust-policies}`
- **Workflows & runs:** `/orgs/:customerId/{runs,registrations,workflows,held-runs,environments,secrets,global-workflows}`
- **Webhooks & event log:** `/orgs/:customerId/{sources,webhook-endpoints,event-log}`
- **Diagnostics & activity:** `/orgs/:customerId/{diagnostics,activity,access-log}`

The full route tree is the source of truth — every method, request schema, and response schema is enumerated server-side. There is currently no auto-generated OpenAPI spec; the typed `DashboardApiType` export is the canonical contract for TypeScript clients.

### Calling the API

Two short examples — adapt the base URL and token to your deployment.

**curl (PAT or API key):**

```bash
TOKEN="$(grep -E '^pat=' ~/.kici/config | cut -d= -f2)"   # or paste a kici_sk_…
ORG="<your-org-id>"
curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  "https://<orchestrator-host>/<deployment-slug>/api/v1/orgs/$ORG/runs?limit=5" | jq
```

**Browser console (after dashboard login):**

```js
const ns = Object.keys(localStorage).find((k) => k.startsWith('oidc.user:'));
const { access_token } = JSON.parse(localStorage.getItem(ns));
const res = await fetch('/<deployment-slug>/api/v1/orgs/<your-org-id>/runs?limit=5', {
  headers: { Authorization: `Bearer ${access_token}` },
});
console.log(await res.json());
```

### Rate limits and body size

There is currently no per-token rate limit on `/api/v1/*`. A single global body-size cap applies to webhook ingress and dashboard API requests alike.

### Audit trail

Every `/api/v1/*` mutation that touches tenant-plane data is recorded in the upstream tenant-plane audit log, stamped with the actor (user, API key, service account, or upstream operator on a break-glass support read). Reads on customer data go through the orchestrator over the WebSocket proxy and land in the orchestrator's `access_log` table. See [Audit log](../operator/security/audit-log.md) for the orchestrator schema and the dashboard's "Activity" page for the federated view.

## Token storage

The CLI stores authentication data in `~/.kici/config` with `0600` permissions (owner read/write only). The config file contains:

- PAT token
- PAT expiry date
- Active organization ID
- Per-org default orchestrator clusters
- Platform endpoint URL

## Troubleshooting

### Browser doesn't open

If `kici login` can't open a browser:

- Use `kici login --device` for the device flow
- Or set the `KICI_BROWSER_CMD` environment variable to your browser command (e.g., `KICI_BROWSER_CMD='firefox {url}'`)

### Device flow timeout

The device flow has a 5-minute timeout. If it expires:

- Run `kici login --device` again to get a new code
- Ensure you're using the correct URL displayed by the CLI

### Expired PAT

If you see "Personal access token has expired":

- Run `kici login` to create a new PAT
- The old expired PAT is automatically superseded

### "Not a member" errors

If authenticated commands return 403:

- Check your active org: `kici org current`
- List available orgs: `kici org list`
- Switch to the correct org: `kici org use <name>`

### Connection refused

If the CLI can't reach the server:

- Verify the endpoint: check `~/.kici/config` for the correct URL
- Test connectivity: `curl <your-platform-url>/health`
