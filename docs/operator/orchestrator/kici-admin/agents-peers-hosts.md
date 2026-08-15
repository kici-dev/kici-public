---
title: 'kici-admin: agents, peers & hosts'
description: 'Agent lifecycle, cluster peers, join tokens, and the host roster'
---

## Guide

### agent -- agent token management and service lifecycle

**Token management:**

```bash
kici-admin agent register [--labels <labels>] [--mandatory-label <label>...] [--privileged-root]
kici-admin agent list [--type static|ephemeral] [--include-pending] [--database-url <url>] [--json]
kici-admin agent revoke <id>
```

- `register` creates a static agent token. The token is shown once -- save it and set `KICI_AGENT_TOKEN` on the agent.
- `--labels` accepts comma-separated labels (e.g., `linux,x64,gpu`) for label-based routing.
- `--mandatory-label` (repeatable) taints the token with a label the agent only accepts jobs demanding (a Kubernetes-taint-style gate). Each mandatory label is also authorized as an advertised label, so the agent can both advertise it (selector) and be confined by it (taint).
- `--privileged-root` is shorthand for `--mandatory-label kici:privileged:root`: it mints a **confined root agent** token. The agent must run as uid 0 — the orchestrator refuses the registration otherwise. See [Confined root agents](../../security/agent-security.md#confined-root-agents) for the full security model.
- `list --include-pending` (HTTP mode only) additionally shows agents that have connected via WS but have not yet completed registration. Pending state is in-memory on the orchestrator, so direct-DB mode cannot surface it.
- `list --database-url` switches to offline direct-DB mode, reading `agent_tokens` directly (pending agents are not visible).

**Service lifecycle:**

```bash
kici-admin agent install [--wizard] [--platform systemd|launchd|windows|compose] [--env-file <path>] [--binary <path>] [--name <name>] [--instance-dir <path>] [--force] [--orchestrator-url <url>] [--token <token>] [--labels <labels>]
kici-admin agent uninstall [--platform <type>] [--instance-dir <path>] [--name <name>]
kici-admin agent start [--platform <type>] [--instance-dir <path>] [--name <name>]
kici-admin agent stop [--platform <type>] [--instance-dir <path>] [--name <name>]
kici-admin agent restart [--platform <type>] [--instance-dir <path>] [--name <name>]
kici-admin agent status [--platform <type>] [--instance-dir <path>] [--name <name>] [--json]
kici-admin agent logs [--platform <type>] [--instance-dir <path>] [--name <name>] [--since <duration>] [--level <level>] [--json] [--no-follow]
kici-admin agent upgrade [--from <path>] [--url <url>] [--version <version>] [--cleanup] [--rollback] [--pick] [--yes] [--force] [--platform <type>] [--instance-dir <path>] [--name <name>]
```

These commands manage the agent as a native system service. The `install --wizard` flow walks through orchestrator URL, agent token, and labels configuration. Lifecycle targeting is folder-anchored — see [Service installation guide](../../distribution/service-installation.md) for platform-specific details and the full description of the manifest, the instance index, and the name-scoped on-disk layout.

Every lifecycle command (`uninstall`, `upgrade`, `start`, `stop`, `restart`, `status`, `logs`) resolves its target through the priority chain `--instance-dir` > `--name` > manifest in the current working directory. A bare `kici-admin agent <cmd>` outside any deploy folder with no flags refuses non-zero and prints the candidate list of installed agent instances on the host.

**Fresh-box bootstrap payloads:**

```bash
kici-admin agent package [--platform <list>] [--out <dir>] [--upload] [--node-mirror <url>] [--npm-registry <url>] [--node-version <ver>]
```

Produces a self-contained agent + Node payload so a fresh host can be brought up without reaching npm or nodejs.org itself.

- `--platform` takes a single target, a comma-separated list, or `all` (default: `linux-x64,linux-arm64`).
- `--out` sets the output directory (default `dist/agent-packages`).
- `--upload` presign-uploads each payload to the orchestrator cache bucket, which is where the bare-metal scaler fetches it from.
- `--node-version` overrides the vendored Node version (default: the Node version running the CLI); `--node-mirror` / `--npm-registry` point the build at internal mirrors.

`kici-admin orchestrator upgrade` produces and uploads these payloads automatically for the new version — pass `--no-agent-packages` there to skip it, or run `agent package` by hand when you need a one-off payload.

### peer -- cluster peer management

```bash
kici-admin peer create-token [--role coordinator|worker] [--expiry-hours <n>] [--org-id <id>] [--routing-key <key>] [--created-by <actor>] [--json]
kici-admin peer list
kici-admin peer revoke --instance-id <id>
kici-admin peer revoke-all --confirm
kici-admin peer prune-credentials --filter <pattern> --database-url <url> [--json]
kici-admin peer reset-raft-state --database-url <url> [--json]
```

Manages peer credentials for multi-orchestrator clusters. These commands access the database directly (not via the admin API).

- `create-token` generates a single-use join token (defaults: coordinator role, 1-hour expiry, org-id `default`, routing-key `default`, attribution `cli`).
  - `--created-by <actor>` sets the `join_tokens.created_by` audit attribution. Defaults to `cli`; deploy scripts pass e.g. `deploy-stg` so staging join-tokens are distinguishable from ad-hoc operator ones.
  - `--json` prints a single JSON object (`{ token, role, orgId, routingKey, expiresAt }`) on stdout instead of the human-readable multi-line output, so callers can pipe it through `JSON.parse` without stripping prose. This is what lets a deploy script mint a token and hand it straight to a joining peer when bootstrapping an HA cluster unattended.
- `revoke` disconnects a peer on its next heartbeat.
- `revoke-all` requires `--confirm` as a safety guard.
- `prune-credentials` (direct-DB only, destructive) deletes every `peer_credentials` row whose `instance_id` does **not** match the `--filter` SQL `LIKE` pattern (e.g. `--filter 'e2e-%'` keeps e2e peers and removes everything else). HTTP mode is intentionally unsupported — the call site is a warm-redeploy preflight run while the orchestrator is stopped.
- `reset-raft-state` (direct-DB only, destructive) deletes every row from `raft_state` so a freshly-started orchestrator self-elects with a clean term. Same offline-only constraint as `prune-credentials`.

See [Clustering](../clustering.md) for full setup details.

### join -- cluster bootstrap

```bash
kici-admin join --token <join-token> --platform <wss://...> --api-key <key>
kici-admin join --token <join-token> --peer <https://orch-1:8080>
```

Bootstraps a new orchestrator into an existing cluster. Connects via Platform relay or direct peer, receives an encrypted config bundle, and writes the local YAML config.

- `--config <path>` sets the output path for the generated config (default: `./kici-orchestrator.yaml`).

### host -- host roster (declared inventory)

```bash
kici-admin host list [--json]
kici-admin host get --agent-id <id> [--json]
kici-admin host declare --agent-id <id> [--labels <labels>] [--hostname <name>]
kici-admin host remove --agent-id <id>
```

- `list` / `get` read the durable host roster and report each host's derived status (`ready` / `unreachable` / `stale`) from the shared last-seen + connected-instance columns.
- `declare` pre-declares a `static` host before its agent connects — until the agent dials in, the host reads `unreachable`, making "expected but not yet here" a visible state.
- `remove` deletes the host's roster row — the retirement path for a box that is gone for good, so it stops reading `unreachable` forever. It exits non-zero when no row matches, and every attempt writes a `fleet.host.remove` `access_log` entry.

These commands read and write the orchestrator database directly (set `KICI_DATABASE_URL`). See [Host roster (declared inventory)](../host-roster.md) for the full model, derived-status table, and the `KICI_ROSTER_GRACE_MS` / `KICI_ROSTER_TTL_MS` timing knobs.

## Reference

<!-- BEGIN GENERATED: kici-admin-agents-peers-hosts (do not edit; run the doc generator) -->

### `kici-admin agent`

Manage agent authentication tokens

Synopsis: `kici-admin agent`

### `kici-admin agent install`

Install the agent as a system service

Synopsis: `kici-admin agent install [options]`

**Options**

| Option                     | Default      | Description                                                                               |
| -------------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| `--platform <type>`        |              | Service platform (systemd, launchd, windows, compose)                                     |
| `--env-file <path>`        |              | Path to existing env/config file to use                                                   |
| `--binary <path>`          |              | Path to agent binary (default: current executable)                                        |
| `--name <name>`            | `kici-agent` | Service name                                                                              |
| `--orchestrator-url <url>` |              | URL of the orchestrator to connect to                                                     |
| `--token <token>`          |              | Agent authentication token                                                                |
| `--labels <labels>`        |              | Comma-separated agent labels for routing                                                  |
| `--wizard`                 |              | Interactive wizard for guided setup                                                       |
| `--system`                 |              | Install as system-level service (requires root)                                           |
| `--user-level`             |              | Install as user-level service (no root required)                                          |
| `--instance-dir <path>`    |              | Deploy folder; the instance manifest is written here (default: current working directory) |
| `--force`                  |              | Overwrite an existing same-named foreign instance                                         |

### `kici-admin agent list`

List agent tokens

Synopsis: `kici-admin agent list [options]`

**Options**

| Option                 | Default | Description                                                                                                                          |
| ---------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `--type <type>`        |         | Filter by type: static or ephemeral                                                                                                  |
| `--include-pending`    |         | Include agents that have connected via WS but have not completed registration (HTTP mode only; direct-DB cannot see in-memory state) |
| `--database-url <url>` |         | Use direct DB access instead of HTTP (offline mode)                                                                                  |
| `--json`               |         | Emit JSON output                                                                                                                     |

### `kici-admin agent logs`

Tail and follow agent service logs

Synopsis: `kici-admin agent logs [options]`

**Options**

| Option                  | Default | Description                                              |
| ----------------------- | ------- | -------------------------------------------------------- |
| `--platform <type>`     |         | Service platform (systemd\|launchd\|windows\|compose)    |
| `--instance-dir <path>` |         | Deploy folder of the instance whose logs to read         |
| `--name <name>`         |         | Service name (no default — must resolve via flag/CWD)    |
| `--system`              |         | Operate against the system-level service (requires root) |
| `--user-level`          |         | Operate against the user-level service                   |
| `--since <duration>`    |         | Show logs since duration (e.g. 1h, 30m)                  |
| `--level <level>`       |         | Filter by log level (error\|warn\|info)                  |
| `--json`                |         | Output as structured JSON                                |
| `--no-follow`           |         | Snapshot mode (do not tail)                              |

### `kici-admin agent package`

Produce a self-contained agent + Node payload for fresh-box bootstrap

Synopsis: `kici-admin agent package [options]`

**Options**

| Option                 | Default               | Description                                                               |
| ---------------------- | --------------------- | ------------------------------------------------------------------------- |
| `--platform <list>`    |                       | Target platform(s): single \| CSV \| all (default: linux-x64,linux-arm64) |
| `--out <dir>`          | `dist/agent-packages` | Output directory                                                          |
| `--upload`             |                       | Presign-upload each payload to the orchestrator cache bucket              |
| `--node-mirror <url>`  |                       | nodejs.org mirror override                                                |
| `--npm-registry <url>` |                       | npm registry override                                                     |
| `--node-version <ver>` |                       | Vendored Node version (default: the Node version running this CLI)        |

### `kici-admin agent register`

Create a static agent token

Synopsis: `kici-admin agent register [options]`

**Options**

| Option                      | Default | Description                                                                                                           |
| --------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `--labels <labels>`         |         | Comma-separated agent labels (e.g. linux,x64)                                                                         |
| `--mandatory-label <label>` |         | Taint label the agent only accepts jobs demanding (repeatable). Also authorized as an advertised label.               |
| `--privileged-root`         |         | Shorthand for --mandatory-label kici:privileged:root: mint a confined root agent token (the agent must run as uid 0). |

### `kici-admin agent restart`

Restart the agent service

Synopsis: `kici-admin agent restart [options]`

**Options**

| Option                  | Default | Description                                              |
| ----------------------- | ------- | -------------------------------------------------------- |
| `--platform <type>`     |         | Service platform (systemd, launchd, windows, compose)    |
| `--instance-dir <path>` |         | Deploy folder of the instance to restart                 |
| `--name <name>`         |         | Service name (no default — must resolve via flag/CWD)    |
| `--system`              |         | Operate against the system-level service (requires root) |
| `--user-level`          |         | Operate against the user-level service                   |

### `kici-admin agent revoke`

Revoke an agent token by ID

Synopsis: `kici-admin agent revoke <id>`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `id`     | yes      | no       |             |

### `kici-admin agent start`

Start the agent service

Synopsis: `kici-admin agent start [options]`

**Options**

| Option                  | Default | Description                                              |
| ----------------------- | ------- | -------------------------------------------------------- |
| `--platform <type>`     |         | Service platform (systemd, launchd, windows, compose)    |
| `--instance-dir <path>` |         | Deploy folder of the instance to start                   |
| `--name <name>`         |         | Service name (no default — must resolve via flag/CWD)    |
| `--system`              |         | Operate against the system-level service (requires root) |
| `--user-level`          |         | Operate against the user-level service                   |

### `kici-admin agent status`

Show agent service status and health information

Synopsis: `kici-admin agent status [options]`

**Options**

| Option                  | Default | Description                                              |
| ----------------------- | ------- | -------------------------------------------------------- |
| `--platform <type>`     |         | Service platform (systemd\|launchd\|windows\|compose)    |
| `--instance-dir <path>` |         | Deploy folder of the instance to inspect                 |
| `--name <name>`         |         | Service name (no default — must resolve via flag/CWD)    |
| `--system`              |         | Operate against the system-level service (requires root) |
| `--user-level`          |         | Operate against the user-level service                   |
| `--json`                |         | Output as JSON                                           |

### `kici-admin agent stop`

Stop the agent service

Synopsis: `kici-admin agent stop [options]`

**Options**

| Option                  | Default | Description                                              |
| ----------------------- | ------- | -------------------------------------------------------- |
| `--platform <type>`     |         | Service platform (systemd, launchd, windows, compose)    |
| `--instance-dir <path>` |         | Deploy folder of the instance to stop                    |
| `--name <name>`         |         | Service name (no default — must resolve via flag/CWD)    |
| `--system`              |         | Operate against the system-level service (requires root) |
| `--user-level`          |         | Operate against the user-level service                   |

### `kici-admin agent uninstall`

Remove the agent service registration

Synopsis: `kici-admin agent uninstall [options]`

**Options**

| Option                  | Default | Description                                              |
| ----------------------- | ------- | -------------------------------------------------------- |
| `--platform <type>`     |         | Service platform (systemd, launchd, windows, compose)    |
| `--instance-dir <path>` |         | Deploy folder of the instance to uninstall               |
| `--name <name>`         |         | Service name (no default — must resolve via flag/CWD)    |
| `--system`              |         | Operate against the system-level service (requires root) |
| `--user-level`          |         | Operate against the user-level service                   |

### `kici-admin agent upgrade`

Upgrade agent to a new version using versioned directory layout

Synopsis: `kici-admin agent upgrade [options]`

**Options**

| Option                  | Default | Description                                                                |
| ----------------------- | ------- | -------------------------------------------------------------------------- |
| `--platform <type>`     |         | Service platform (systemd\|launchd\|windows\|compose)                      |
| `--instance-dir <path>` |         | Deploy folder of the instance to upgrade                                   |
| `--name <name>`         |         | Service name (no default — must resolve via flag/CWD)                      |
| `--from <path>`         |         | Path to package archive (.tar.gz or .zip)                                  |
| `--url <url>`           |         | URL to download package archive from                                       |
| `--version <version>`   |         | Target version string (e.g., 0.3.0)                                        |
| `--yes`                 |         | Skip confirmation prompt                                                   |
| `--force`               |         | Overwrite existing versioned directory                                     |
| `--cleanup`             |         | Remove old versions (keeps current and previous)                           |
| `--rollback`            |         | Roll back to the previous version                                          |
| `--pick`                |         | Interactively pick an installed version to activate                        |
| `--restart-only`        |         | Restart the already-installed package without installing (skip self-drive) |

### `kici-admin host`

Inspect and declare the host roster

Synopsis: `kici-admin host`

### `kici-admin host declare`

Pre-declare a static host before it connects

Synopsis: `kici-admin host declare [options]`

**Options**

| Option                   | Default | Description                                                                                                                                      |
| ------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--agent-id <id>`        |         | Agent id the host will register as                                                                                                               |
| `--labels <labels>`      |         | Comma-separated labels                                                                                                                           |
| `--hostname <name>`      |         | Hostname                                                                                                                                         |
| `--prop <key=value>`     |         | Typed host property (repeatable; true/false ⇒ boolean, numeric ⇒ number)                                                                         |
| `--address <host>`       |         | Pre-agent SSH reach address (IP / hostname) for bootstrap                                                                                        |
| `--ssh-user <user>`      |         | SSH login user for bootstrap bring-up                                                                                                            |
| `--ssh-port <port>`      |         | SSH port for bootstrap bring-up                                                                                                                  |
| `--ssh-key-secret <ref>` |         | Scoped-secret ref (scope/key) holding the bring-up private key                                                                                   |
| `--s3-reachable`         |         | The box can reach the orchestrator object storage — bring-up delivers the agent payload via a presigned S3 pull (else it falls back to SSH-push) |

### `kici-admin host get`

Show one roster host

Synopsis: `kici-admin host get [options]`

**Options**

| Option            | Default | Description |
| ----------------- | ------- | ----------- |
| `--agent-id <id>` |         | Agent id    |
| `--json`          |         | Output JSON |

### `kici-admin host list`

List all roster hosts

Synopsis: `kici-admin host list [options]`

**Options**

| Option   | Default | Description |
| -------- | ------- | ----------- |
| `--json` |         | Output JSON |

### `kici-admin host remove`

Remove a host from the roster

Synopsis: `kici-admin host remove [options]`

**Options**

| Option            | Default | Description        |
| ----------------- | ------- | ------------------ |
| `--agent-id <id>` |         | Agent id to remove |

### `kici-admin join`

Join an existing orchestrator cluster using a join token

Synopsis: `kici-admin join [options]`

**Options**

| Option             | Default                    | Description                                                         |
| ------------------ | -------------------------- | ------------------------------------------------------------------- |
| `--token <token>`  |                            | Join token (kici_join_v1.<routing>.<secret>)                        |
| `--platform <url>` |                            | Platform WebSocket URL for relay mode (e.g., wss://api.kici.dev/ws) |
| `--peer <url>`     |                            | Peer HTTP URL for direct mode (e.g., https://orch-1:8080)           |
| `--api-key <key>`  |                            | API key for Platform authentication (required for --platform mode)  |
| `--config <path>`  | `./kici-orchestrator.yaml` | Path to write the resulting local config YAML                       |

### `kici-admin peer`

Manage peer tokens and credentials

Synopsis: `kici-admin peer`

### `kici-admin peer create-token`

Create a join token for a new peer

Synopsis: `kici-admin peer create-token [options]`

**Options**

| Option                   | Default       | Description                                                       |
| ------------------------ | ------------- | ----------------------------------------------------------------- |
| `--role <role>`          | `coordinator` | Peer role (worker or coordinator)                                 |
| `--expiry-hours <hours>` | `1`           | Token expiry in hours                                             |
| `--org-id <id>`          | `default`     | Organization ID                                                   |
| `--routing-key <key>`    | `default`     | Routing key                                                       |
| `--created-by <actor>`   | `cli`         | Attribution written to join_tokens.created_by                     |
| `--json`                 | `false`       | Emit JSON { token, role, expiresAt, orgId, routingKey } on stdout |

### `kici-admin peer list`

List active peer credentials

Synopsis: `kici-admin peer list`

### `kici-admin peer prune-credentials`

DELETE peer_credentials rows whose instance_id does NOT LIKE <filter> (direct-DB only, destructive). Used by cluster e2e to wipe stale staging peer credentials while leaving e2e-* peers intact. HTTP mode is intentionally unsupported: the call site is a warm-deploy preflight run while the orchestrator is stopped, mirroring peer reset-raft-state.

Synopsis: `kici-admin peer prune-credentials [options]`

**Options**

| Option                 | Default | Description                                                                                   |
| ---------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `--filter <pattern>`   |         | SQL LIKE pattern for instance_ids to KEEP (e.g. "e2e-%"). Rows that do NOT match are deleted. |
| `--database-url <url>` |         | Use direct DB access (offline mode, required)                                                 |
| `--json`               | `false` | Emit JSON { deleted } on stdout                                                               |

### `kici-admin peer reset-raft-state`

DELETE all rows from raft_state so a freshly-started orchestrator self-elects with a clean term (direct-DB only, destructive)

Synopsis: `kici-admin peer reset-raft-state [options]`

**Options**

| Option                 | Default | Description                                   |
| ---------------------- | ------- | --------------------------------------------- |
| `--database-url <url>` |         | Use direct DB access (offline mode, required) |
| `--json`               | `false` | Emit JSON { rowsDeleted } on stdout           |

### `kici-admin peer revoke`

Revoke a peer credential by instance ID

Synopsis: `kici-admin peer revoke [options]`

**Options**

| Option               | Default | Description                       |
| -------------------- | ------- | --------------------------------- |
| `--instance-id <id>` |         | Instance ID of the peer to revoke |

### `kici-admin peer revoke-all`

Revoke all active peer credentials

Synopsis: `kici-admin peer revoke-all [options]`

**Options**

| Option      | Default | Description                                |
| ----------- | ------- | ------------------------------------------ |
| `--confirm` |         | Confirm revocation of all peer credentials |

<!-- END GENERATED: kici-admin-agents-peers-hosts -->
