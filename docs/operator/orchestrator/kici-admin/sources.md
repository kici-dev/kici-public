---
title: 'kici-admin: sources'
description: 'Webhook source and remote-run anchor management'
---

## Guide

### source -- webhook source management

```bash
# GitHub App sources
# One-click setup: create AND configure a brand-new GitHub App via the App Manifest flow
kici-admin source add github --name <name> --manifest [--github-org <slug>] [--webhook-url <url>] [--no-browser] [--json]
# Manual: store credentials for a GitHub App you already created
kici-admin source add github --name <name> --app-id <id> --private-key <value|@file> [--webhook-secret <secret>] [--from-env <var>] [--stdin]
kici-admin source update <routingKey> [--name <name>] [--private-key <value|@file>] [--webhook-secret <secret>] [--from-env <var>] [--stdin]
# Re-sync a GitHub source's display name + slug from GitHub (GitHub is the source of truth)
kici-admin source refresh <routingKey> [--json]
kici-admin source refresh --all [--json]
kici-admin source get-webhook-secret <routingKey>
kici-admin source remove <routingKey> [--yes]

# Generic webhook sources
kici-admin source add generic --org <orgId> --name <name> [--from-env <var>] [--stdin] [options]
kici-admin source get <id>
kici-admin source update-generic <id> [--from-env <var>] [--stdin] [options]
kici-admin source remove <id> --generic [--hard] [--yes]
kici-admin source enable <id>
kici-admin source disable <id>

# Local filesystem (file://) sources — a git repo present on the agent
# filesystem (see the Local filesystem source guide). verification='none'.
kici-admin source add local --org <orgId> --path <abs-dir> [--name <name>] [--clone-url-base <url>]
kici-admin source update-local <id> [--path <abs-dir>] [--name <name>]
kici-admin source remove <routingKey> --local [--hard] [--yes]
kici-admin source trigger-local <id> [--event push|pull_request] [--ref <ref>] [--sha <sha>] [--repo-full-name <name>]
kici-admin source install-hook <id> [--repo <path>]

# List all sources (without --org, only GitHub sources are shown)
kici-admin source list [--org <orgId>] [--include-deleted]
```

**One-click manifest setup** (`--manifest`): the recommended path for a brand-new App. The CLI builds a pre-filled GitHub App manifest (permissions, events, webhook URL), opens GitHub for you to click **"Create GitHub App"** once, captures the returned credentials, stores them encrypted on the orchestrator, and walks you through installing the App on your repos. It always creates a **new** App on GitHub. Flags:

| Flag                  | Description                                                                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--manifest`          | Enable one-click setup via GitHub's App Manifest flow (mutually exclusive with `--app-id` / `--private-key`)                                                                        |
| `--github-org <slug>` | Create the App under a GitHub organization instead of your personal account                                                                                                         |
| `--webhook-url <url>` | Advanced/self-hosted: bake this `https://` URL into the App webhook verbatim and skip platform-mode URL resolution. KiCI adds no ingress at this URL — your own infra owns delivery |
| `--no-browser`        | Headless mode: print a `kici.dev` URL to open, then read the short-lived setup code you paste back via stdin                                                                        |
| `--json`              | Emit raw JSON (the API response) instead of formatted text                                                                                                                          |

**`source refresh`**: re-reads a GitHub source's display name + slug from GitHub (`GET /app`) and updates the orchestrator + dashboard if they drifted (e.g. after renaming the App in GitHub's UI). For GitHub App sources GitHub is the source of truth for the displayed name — `--name` is only the name requested at creation. Pass a `<routingKey>` for one source or `--all` for every GitHub source; the command prints `old → new` for any changed field and is a no-op when GitHub already matches. The orchestrator also runs this refresh automatically once a day (`KICI_GITHUB_APP_NAME_REFRESH_INTERVAL_MS`, default 24h). Non-GitHub routing keys are rejected.

See the [GitHub provider guide](../../../user/providers/github.md) for the full one-click walkthrough. The manifest flow resolves the App's webhook URL from the orchestrator's Platform connection, so it requires a **platform** or **hybrid** orchestrator. **Independent-mode** orchestrators have no Platform connection (and therefore no GitHub-App ingress), so the pre-flight returns no webhook URL and the flow aborts — use a generic webhook source there instead.

**Secret input modes** (for private keys and webhook secrets — the manual path):

| Mode                 | Example                             |
| -------------------- | ----------------------------------- |
| Direct value         | `--private-key "-----BEGIN RSA..."` |
| File (@ prefix)      | `--private-key @/path/to/key.pem`   |
| Environment variable | `--from-env GITHUB_APP_KEY`         |
| Stdin                | `--stdin`                           |

**Universal-git options** (promote a generic source to clone + trigger-match for Forgejo / Gitea / Gogs / GitLab / plain GitHub — see [Universal-git provider](../../../user/providers/universal-git.md)):

List the canonical presets and their expanded `payloadPaths` + `eventMapping`:

```bash
kici-admin source list-presets
```

**Local filesystem (`file://`) source options** (a git repo present on the agent
filesystem — see the [Local filesystem source guide](../../../user/providers/local-file.md)):

`source add local` always registers verification `none` — there is no remote
forge to sign the payload, so only register repos you trust. Drive runs with
`source trigger-local <id>` (reads the repo HEAD and POSTs a synthetic push) or
install a `post-receive` hook with `source install-hook <id>` so every push
triggers a run. The orchestrator accepts a local source on any scaler backend
and logs a reachability warning (not a rejection) on container / Firecracker
scalers, where the repo must be baked into the image / rootfs or bind-mounted at
the registered path.

### source -- source maintenance (purge-stale)

```bash
kici-admin source purge-stale --routing-key <key> --dry-run
kici-admin source purge-stale --routing-key <key> --confirm
```

Counts (`--dry-run`) or deletes (`--confirm`) orphan `sources` rows, their scoped webhook/private-key secrets, and all `generic_webhook_sources` rows. `generic_webhook_sources` is single-tenant per deployment so it's cleared wholesale. Pair with `source add` / `source update` to re-seed the current deployment's sources afterward.

### remote-source -- remote-run org anchor inspection

```bash
kici-admin remote-source show <orgId>
```

Inspects the orchestrator's auto-provisioned **remote source** for an organization — the system-managed row (routing key `remote:<orgId>`) that anchors the org so `kici run remote` can dispatch to it without any manual webhook source. The orchestrator provisions one automatically for its bound org, so there is nothing to create or remove; this command is read-only.

Use it to debug org-anchor issues on an orchestrator that sits behind a private network: confirm the remote source exists and maps the expected routing key to the org. If a developer's `kici run remote` reports that the org is not routable, `remote-source show <orgId>` is the first check.

## Reference

<!-- BEGIN GENERATED: kici-admin-sources (do not edit; run the doc generator) -->

### `kici-admin remote-source`

Inspect the auto-provisioned remote-source org anchor

Synopsis: `kici-admin remote-source`

### `kici-admin remote-source show`

Print the remote_sources anchor row for an org (routing key remote:<orgId>).

Synopsis: `kici-admin remote-source show <orgId> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `orgId`  | yes      | no       |             |

**Options**

| Option                 | Default | Description                                  |
| ---------------------- | ------- | -------------------------------------------- |
| `--database-url <url>` |         | Orchestrator DB URL (else KICI_DATABASE_URL) |
| `--format <format>`    | `table` | Output format: json\|table                   |

### `kici-admin source`

Manage webhook sources

Synopsis: `kici-admin source`

### `kici-admin source add`

Add a new webhook source

Synopsis: `kici-admin source add`

### `kici-admin source add generic`

Add a new generic webhook source

Synopsis: `kici-admin source add generic [options]`

**Options**

| Option                                | Default | Description                                                                                                 |
| ------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `--org <orgId>`                       |         | Organization/customer ID                                                                                    |
| `--name <name>`                       |         | Human-readable source name                                                                                  |
| `--verification <method>`             |         | Verification method: hmac_sha256, bearer_token, ip_allowlist, none                                          |
| `--secret <value>`                    |         | Verification secret (HMAC secret or bearer token, prefix with @ for file)                                   |
| `--from-env <varName>`                |         | Read verification secret from environment variable                                                          |
| `--stdin`                             |         | Read verification secret from stdin                                                                         |
| `--event-type-header <header>`        |         | Header name for event type extraction                                                                       |
| `--event-type-path <jsonpath>`        |         | JSONPath for event type extraction from body                                                                |
| `--idempotency-key-header <header>`   |         | Header name for idempotency key                                                                             |
| `--idempotency-key-path <jsonpath>`   |         | JSONPath for idempotency key from body                                                                      |
| `--dedup-window <seconds>`            |         | Dedup window in seconds (default: 300)                                                                      |
| `--max-payload <bytes>`               |         | Maximum payload size in bytes (default: 1048576)                                                            |
| `--allowed-events <events>`           |         | Comma-separated list of allowed event types                                                                 |
| `--strip-headers <headers>`           |         | Comma-separated list of headers to strip                                                                    |
| `--rate-limit <rpm>`                  |         | Rate limit in requests per minute (default: 600)                                                            |
| `--preset <name>`                     |         | Universal-git preset: forgejo, gitea, gogs, gitlab-repo, github-repo, custom                                |
| `--git-url-template <url>`            |         | Clone URL template with {owner}/{name}/{repo}                                                               |
| `--credential-ref <key>`              |         | Secret key name (under **source**/<id> scope)                                                               |
| `--credential-store <backend>`        |         | Secret backend name (default: pg)                                                                           |
| `--credential-type <type>`            |         | Credential type: pat, basic, ssh                                                                            |
| `--credential-user <user>`            |         | Username for PAT/basic auth (default: x-access-token)                                                       |
| `--ssh-host-key-policy <policy>`      |         | SSH host-key policy: accept-new, pinned                                                                     |
| `--ssh-known-hosts-pem <pathOrValue>` |         | Pinned SSH known_hosts (prefix with @ for file). Required when --ssh-host-key-policy=pinned                 |
| `--provider-type <type>`              |         | Provider implementation: generic (default) or local (a git repo on the agent filesystem cloned via file://) |
| `--json`                              |         | Emit raw JSON (the full source row) instead of formatted text                                               |

### `kici-admin source add github`

Add a new GitHub App source

Synopsis: `kici-admin source add github [options]`

**Options**

| Option                        | Default | Description                                                                                                                                                                        |
| ----------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--name <name>`               |         | Human-readable source name                                                                                                                                                         |
| `--app-id <id>`               |         | GitHub App ID (omit when using --manifest)                                                                                                                                         |
| `--private-key <pathOrValue>` |         | Private key (prefix with @ for file path)                                                                                                                                          |
| `--webhook-secret <secret>`   |         | Webhook secret (use "-" to read from stdin)                                                                                                                                        |
| `--from-env <varName>`        |         | Read private key from environment variable                                                                                                                                         |
| `--stdin`                     |         | Read private key from stdin                                                                                                                                                        |
| `--manifest`                  |         | One-click setup: create and configure a new GitHub App via the App Manifest flow                                                                                                   |
| `--no-browser`                |         | Headless manifest setup: print a URL and paste the setup code back                                                                                                                 |
| `--github-org <slug>`         |         | Create the App under a GitHub org instead of your personal account                                                                                                                 |
| `--webhook-url <url>`         |         | Advanced/self-hosted: bake this https:// URL into the App webhook verbatim and skip platform-mode URL resolution. KiCI adds no ingress at this URL — your own infra owns delivery. |
| `--json`                      |         | Emit raw JSON (the API response) instead of formatted text                                                                                                                         |

### `kici-admin source add local`

Register a git repo present on the agent filesystem as a file:// source

Synopsis: `kici-admin source add local [options]`

**Options**

| Option                   | Default | Description                                                                                                      |
| ------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `--org <orgId>`          |         | Organization/customer ID                                                                                         |
| `--path <dir>`           |         | Absolute path to the repo (or base dir of repos) on the agent filesystem                                         |
| `--name <name>`          | `local` | Human-readable source name                                                                                       |
| `--clone-url-base <url>` |         | Optional git://\|http:// base for remote agents that do not share the orchestrator filesystem (default: file://) |
| `--json`                 |         | Emit raw JSON (the full source row) instead of formatted text                                                    |
| `--database-url <url>`   |         | Use direct DB access instead of HTTP (offline mode)                                                              |

### `kici-admin source disable`

Disable a generic webhook source

Synopsis: `kici-admin source disable <id>`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `id`     | yes      | no       |             |

### `kici-admin source enable`

Enable a generic webhook source

Synopsis: `kici-admin source enable <id> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `id`     | yes      | no       |             |

**Options**

| Option                 | Default | Description                                         |
| ---------------------- | ------- | --------------------------------------------------- |
| `--database-url <url>` |         | Use direct DB access instead of HTTP (offline mode) |

### `kici-admin source get`

Get details of a generic webhook source

Synopsis: `kici-admin source get <id> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `id`     | yes      | no       |             |

**Options**

| Option   | Default | Description                                                   |
| -------- | ------- | ------------------------------------------------------------- |
| `--json` |         | Emit raw JSON (the full source row) instead of formatted text |

### `kici-admin source get-webhook-secret`

Get the webhook secret for a source (for GitHub webhook configuration)

Synopsis: `kici-admin source get-webhook-secret <routingKey>`

**Arguments**

| Argument     | Required | Variadic | Description |
| ------------ | -------- | -------- | ----------- |
| `routingKey` | yes      | no       |             |

### `kici-admin source install-hook`

Install a post-receive hook in the local source repo that triggers runs on push

Synopsis: `kici-admin source install-hook <id> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `id`     | yes      | no       |             |

**Options**

| Option             | Default                 | Description                                  |
| ------------------ | ----------------------- | -------------------------------------------- |
| `--repo <path>`    |                         | Repo path (default: the source repoBasePath) |
| `--base-url <url>` | `http://localhost:8080` | Orchestrator base URL                        |

### `kici-admin source list`

List all configured sources (GitHub and generic)

Synopsis: `kici-admin source list [options]`

**Options**

| Option                 | Default | Description                                                               |
| ---------------------- | ------- | ------------------------------------------------------------------------- |
| `--org <orgId>`        |         | Filter generic sources by organization ID                                 |
| `--include-deleted`    |         | Include soft-deleted generic sources                                      |
| `--json`               |         | Emit raw JSON ({github: [...], generic: [...]}) instead of formatted text |
| `--database-url <url>` |         | Use direct DB access instead of HTTP (offline mode)                       |

### `kici-admin source list-presets`

List built-in universal-git presets (forge shapes supported out of the box)

Synopsis: `kici-admin source list-presets [options]`

**Options**

| Option              | Default | Description                |
| ------------------- | ------- | -------------------------- |
| `--format <format>` | `table` | Output format: table\|json |

### `kici-admin source purge-stale`

DELETE sources + scoped secrets whose routing_key differs from the current cluster

Synopsis: `kici-admin source purge-stale [options]`

**Options**

| Option                 | Default | Description                                            |
| ---------------------- | ------- | ------------------------------------------------------ |
| `--database-url <url>` |         | Use direct DB access instead of HTTP (offline mode)    |
| `--routing-key <key>`  |         | Current routing key to preserve                        |
| `--dry-run`            | `false` | Count stale rows without deleting them                 |
| `--confirm`            |         | Explicit confirmation flag (required unless --dry-run) |

### `kici-admin source refresh`

Re-sync a GitHub source's name and slug from GitHub (use --all for every source)

Synopsis: `kici-admin source refresh [routingKey] [options]`

**Arguments**

| Argument     | Required | Variadic | Description |
| ------------ | -------- | -------- | ----------- |
| `routingKey` | no       | no       |             |

**Options**

| Option   | Default | Description                             |
| -------- | ------- | --------------------------------------- |
| `--all`  |         | Refresh every GitHub source             |
| `--json` |         | Emit raw JSON instead of formatted text |

### `kici-admin source remove`

Remove a source (GitHub, or generic/local with --generic / --local)

Synopsis: `kici-admin source remove <routingKey> [options]`

**Arguments**

| Argument     | Required | Variadic | Description |
| ------------ | -------- | -------- | ----------- |
| `routingKey` | yes      | no       |             |

**Options**

| Option                 | Default | Description                                                               |
| ---------------------- | ------- | ------------------------------------------------------------------------- |
| `--yes`                |         | Skip confirmation                                                         |
| `--generic`            |         | Remove a generic source (routingKey is treated as source ID)              |
| `--local`              |         | Remove a local (file://) source (routingKey is treated as source ID)      |
| `--hard`               |         | Permanently delete a generic/local source (requires --generic or --local) |
| `--database-url <url>` |         | Use direct DB access instead of HTTP (offline mode)                       |

### `kici-admin source trigger-local`

Trigger a run against a local source (reads HEAD when --ref/--sha omitted)

Synopsis: `kici-admin source trigger-local <id> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `id`     | yes      | no       |             |

**Options**

| Option                    | Default                 | Description                               |
| ------------------------- | ----------------------- | ----------------------------------------- |
| `--event <event>`         | `push`                  | push \| pull_request                      |
| `--ref <ref>`             |                         | Git ref (default: repo HEAD branch)       |
| `--sha <sha>`             |                         | Commit SHA (default: repo HEAD)           |
| `--repo-full-name <name>` | `local/repo`            | owner/name identifier used in the payload |
| `--base-url <url>`        | `http://localhost:8080` | Orchestrator base URL                     |

### `kici-admin source update`

Update a GitHub source

Synopsis: `kici-admin source update <routingKey> [options]`

**Arguments**

| Argument     | Required | Variadic | Description |
| ------------ | -------- | -------- | ----------- |
| `routingKey` | yes      | no       |             |

**Options**

| Option                        | Default | Description                                                        |
| ----------------------------- | ------- | ------------------------------------------------------------------ |
| `--name <name>`               |         | New name                                                           |
| `--private-key <pathOrValue>` |         | New private key (prefix with @ for file)                           |
| `--webhook-secret <secret>`   |         | New webhook secret                                                 |
| `--from-env <varName>`        |         | Read new private key from environment variable                     |
| `--stdin`                     |         | Read new private key from stdin                                    |
| `--customer-id <orgId>`       |         | Update the customer/org ID used for secret and environment scoping |
| `--database-url <url>`        |         | Use direct DB access instead of HTTP (offline mode)                |

### `kici-admin source update-generic`

Update a generic webhook source

Synopsis: `kici-admin source update-generic <id> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `id`     | yes      | no       |             |

**Options**

| Option                                | Default | Description                                                                                                 |
| ------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `--name <name>`                       |         | New name                                                                                                    |
| `--verification <method>`             |         | Verification method: hmac_sha256, bearer_token, ip_allowlist, none                                          |
| `--secret <value>`                    |         | New verification secret (prefix with @ for file)                                                            |
| `--from-env <varName>`                |         | Read verification secret from environment variable                                                          |
| `--stdin`                             |         | Read verification secret from stdin                                                                         |
| `--event-type-header <header>`        |         | Header name for event type extraction                                                                       |
| `--event-type-path <jsonpath>`        |         | JSONPath for event type extraction from body                                                                |
| `--idempotency-key-header <header>`   |         | Header name for idempotency key                                                                             |
| `--idempotency-key-path <jsonpath>`   |         | JSONPath for idempotency key from body                                                                      |
| `--dedup-window <seconds>`            |         | Dedup window in seconds                                                                                     |
| `--max-payload <bytes>`               |         | Maximum payload size in bytes                                                                               |
| `--allowed-events <events>`           |         | Comma-separated list of allowed event types                                                                 |
| `--strip-headers <headers>`           |         | Comma-separated list of headers to strip                                                                    |
| `--rate-limit <rpm>`                  |         | Rate limit in requests per minute                                                                           |
| `--preset <name>`                     |         | Universal-git preset                                                                                        |
| `--git-url-template <url>`            |         | Clone URL template                                                                                          |
| `--credential-ref <key>`              |         | Secret key name                                                                                             |
| `--credential-store <backend>`        |         | Secret backend name                                                                                         |
| `--credential-type <type>`            |         | Credential type: pat, basic, ssh                                                                            |
| `--credential-user <user>`            |         | Username for PAT/basic auth                                                                                 |
| `--ssh-host-key-policy <policy>`      |         | SSH host-key policy: accept-new, pinned                                                                     |
| `--ssh-known-hosts-pem <pathOrValue>` |         | Pinned SSH known_hosts (prefix with @ for file)                                                             |
| `--clear-git-config`                  |         | Revert this source back to a payload-only generic webhook                                                   |
| `--provider-type <type>`              |         | Provider implementation: generic (default) or local (a git repo on the agent filesystem cloned via file://) |
| `--json`                              |         | Emit raw JSON (the full source row) instead of formatted text                                               |

### `kici-admin source update-local`

Update a local filesystem (file://) source

Synopsis: `kici-admin source update-local <id> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `id`     | yes      | no       |             |

**Options**

| Option                   | Default | Description                                                   |
| ------------------------ | ------- | ------------------------------------------------------------- |
| `--name <name>`          |         | New name                                                      |
| `--path <dir>`           |         | New absolute repo base path on the agent filesystem           |
| `--clone-url-base <url>` |         | New git://\|http:// clone base (default: file://)             |
| `--json`                 |         | Emit raw JSON (the full source row) instead of formatted text |
| `--database-url <url>`   |         | Use direct DB access instead of HTTP (offline mode)           |

<!-- END GENERATED: kici-admin-sources -->
