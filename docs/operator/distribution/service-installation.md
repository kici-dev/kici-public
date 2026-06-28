---
title: Service installation guide
description: ''
---

This guide covers installing and managing the KiCI orchestrator and agent as native system services using the `kici-admin` CLI.

> **Pre-release note**: This version introduces folder-anchored instance targeting. The on-disk layout is breaking — per-instance config, log, and install directories are now name-scoped under `<root>/<name>/`. Re-install any existing instance to adopt the new layout; there is no automatic migration.

## Overview

The `kici-admin` CLI provides commands to install, manage, and upgrade the orchestrator and agent as native services on:

- **Linux** -- systemd (system-level or user-level)
- **macOS** -- launchd (system-level or user-level)
- **Windows** -- Windows Services via [shawl](https://github.com/mtkennerly/shawl)
- **Docker/Podman** -- Compose file generation

Commands are organized into two groups:

```
kici-admin orchestrator install|uninstall|start|stop|restart|status|logs|upgrade
kici-admin agent install|uninstall|start|stop|restart|status|logs|upgrade
```

## Instance directory and manifest

Each `kici-admin orchestrator install` (and `kici-admin agent install`) writes a **manifest** into a deploy folder — `.kici-orchestrator.json` for the orchestrator, `.kici-agent.json` for the agent. The deploy folder is the **instance directory**: pass `--instance-dir <path>` to choose it explicitly; the default is the current working directory. Every subsequent `kici-admin <component> <cmd>` resolves its target via this manifest — either by running the command from inside the deploy folder, or by passing `--instance-dir <path>` explicitly.

The host's installed instances are tracked at an **instance index**:

- User-level: `~/.config/kici/instances.json` (Linux), `~/Library/Application Support/kici/instances.json` (macOS), `%LOCALAPPDATA%\kici\instances.json` (Windows).
- System-level: `/etc/kici/instances.json` (Linux/macOS), `C:\ProgramData\kici\instances.json` (Windows).

The index is a reconciled cache, not the source of truth. `install` also embeds the deploy folder directly in the generated service definition (an `X-KiCI-InstanceDir` directive in the systemd unit, the equivalent plist key / container label / service-description marker on other platforms). Every command rebuilds the index from the init system's native scan: it drops stale entries whose units are gone, and it re-adopts the deploy folder straight from the unit marker when the index entry is missing. So even if the index file is deleted or emptied, `--name` resolution still finds the deploy folder and the index self-heals on the next command. (Units installed before the marker existed have no embedded folder; for those, re-run `install`/`upgrade` once with `--instance-dir` to regenerate the unit with the marker.)

To point the instance index (and the per-instance config dirs) at a directory other than the platform default, set `KICI_CONFIG_ROOT`. This isolates one host's instances from another tool's — useful when test harnesses install throwaway instances alongside a real one and must not share its index.

### Name-scoped on-disk layout

Per-instance paths embed the service name as a directory segment, so two instances with different `--name` values are fully isolated:

- Config: `<configRoot>/<name>/` (e.g. `/etc/kici/<name>/`, `~/.config/kici/<name>/`).
- Logs: `<logRoot>/<name>/` (e.g. `/var/log/kici/<name>/`, `~/.local/share/kici/<name>/logs/`).
- Install base: `<installBase>/<name>/` (e.g. `/opt/kici/<name>/` on systemd, `/usr/local/kici/<name>/` on launchd, `C:\Program Files\KiCI\<name>\` on Windows).

Both instances can run different versions concurrently — `upgrade` flips the symlink only inside the resolved instance's own `<installBase>/<name>/` tree.

### Multi-instance hosts

When running multiple orchestrators or agents on one host (for example, a dogfood instance alongside an E2E test instance), give each a distinct `--name` and a distinct `--instance-dir`. The `install` command guards against accidental collisions: it refuses to register a same-named instance at a different `--instance-dir` unless you pass `--force`. The error names the existing instance directory so you can choose between picking a different name, picking a different deploy folder, or explicitly overwriting.

### Targeting operating commands

Every lifecycle command — `uninstall`, `upgrade`, `start`, `stop`, `restart`, `status`, `logs` — requires explicit targeting. The resolution priority is:

1. `--instance-dir <path>` flag.
2. `--name <name>` flag (matches against the reconciled instance list for the current privilege scope).
3. A manifest in the current working directory (`./.kici-orchestrator.json` or `./.kici-agent.json`).

If none of those resolve, the command exits non-zero with a candidate list of installed instances on the host. `--name` no longer has a default — a bare `kici-admin orchestrator uninstall` outside any deploy folder will refuse and list the candidates.

## Prerequisites

You need one of:

- A **full package** (standalone, includes Node.js binary) -- see [Packaging guide](./sea-binaries.md)
- **Node.js 24+** with the orchestrator package installed via npm

For Windows, [shawl](https://github.com/mtkennerly/shawl) is downloaded automatically on first install (cached for future use).

## Quick start

The examples below pin each install to an explicit `--instance-dir` so subsequent lifecycle commands can resolve the manifest unambiguously. Omit `--instance-dir` to anchor the manifest in the current working directory; either way, run subsequent commands from the deploy folder or pass `--instance-dir` again.

### Linux (systemd)

```bash
# System-level service (run as root)
sudo kici-admin orchestrator install --wizard --instance-dir /opt/kici-deploy

# User-level service (no sudo needed)
kici-admin orchestrator install --wizard --instance-dir ~/kici-deploy

# Start the service (resolves the manifest in CWD)
cd ~/kici-deploy
kici-admin orchestrator start

# Or target it explicitly from anywhere
kici-admin orchestrator status --instance-dir ~/kici-deploy
```

### macOS (launchd)

```bash
# User-level service (recommended)
kici-admin orchestrator install --wizard --instance-dir ~/kici-deploy

# System-level service
sudo kici-admin orchestrator install --wizard --instance-dir /opt/kici-deploy

# Start the service
kici-admin orchestrator start --instance-dir ~/kici-deploy
```

### Windows

Open PowerShell as Administrator:

```powershell
# Install with interactive wizard
kici-admin orchestrator install --wizard --instance-dir C:\kici-deploy

# Start the service
kici-admin orchestrator start --instance-dir C:\kici-deploy

# Check status
kici-admin orchestrator status --instance-dir C:\kici-deploy
```

### Docker/Podman Compose

```bash
# Generate a compose file
kici-admin orchestrator install \
  --platform compose \
  --instance-dir ./kici-orchestrator \
  --env-file ./orchestrator.env

# Start with Docker Compose
cd ./kici-orchestrator
docker compose up -d
```

#### Image pinning by manifest-list digest

The generated compose file pins the image by **manifest-list digest**, not the
mutable `:latest` tag:

```yaml
image: quay.io/kici-dev/kici-orchestrator:0.1.15@sha256:<index-digest>
```

The digest is the multi-arch image-index digest recorded at release time, so the
same reference resolves the correct image on both `linux/amd64` and `linux/arm64`,
and a `docker`/`podman pull` verifies the hash — a registry that serves
substituted content fails the pull. The exact digests for each release are
published on the [release artifacts page](./release-artifacts.md).

Because the pin is baked into the generated file, **upgrading means regenerating
the installer from a newer `kici-admin`** (re-run `kici-admin orchestrator install`
from the version you want) — that writes a new compose file with the new release's
digest. Pulling a different image without regenerating is a deliberate manual edit
of the pin.

If you generate the compose file from a development build that never ran a release,
the installer falls back to the `:latest` tag (with a warning) since no recorded
digest ships with that build.

## Installation modes

### Wizard mode (`--wizard`)

Interactive guided setup. Asks only essential questions with sensible defaults:

1. **Operating mode** -- Platform (connects to KiCI Cloud), Hybrid, or Independent
2. **Database URL** -- PostgreSQL connection string
3. **Port** -- HTTP server port (default: 4000)
4. **Secrets key** -- 32-byte hex encryption key (auto-generated with option to customize)
5. **Platform connection** (if Platform/Hybrid mode) -- relay URL and API key

```bash
kici-admin orchestrator install --wizard
```

### Flags mode

Provide configuration via CLI flags or an existing env file:

```bash
kici-admin orchestrator install \
  --env-file /path/to/orchestrator.env \
  --binary /usr/local/bin/kici-orchestrator \
  --name kici-orchestrator \
  --instance-dir ~/kici-deploy \
  --platform systemd
```

Available flags:

| Flag                    | Description                                                                           | Default                   |
| ----------------------- | ------------------------------------------------------------------------------------- | ------------------------- |
| `--platform <type>`     | Force platform: `systemd`, `launchd`, `windows`, `compose`                            | Auto-detected             |
| `--env-file <path>`     | Path to existing env/config file                                                      | Creates new in config dir |
| `--binary <path>`       | Path to orchestrator binary                                                           | Current executable        |
| `--name <name>`         | Service name (also the per-instance directory segment under config/log/install roots) | `kici-orchestrator`       |
| `--instance-dir <path>` | Deploy folder where the instance manifest is written and resolved from                | Current working directory |
| `--force`               | Overwrite a same-named instance already installed at a different `--instance-dir`     | Off                       |
| `--dev`                 | Dev mode with local PostgreSQL                                                        | Off                       |
| `--wizard`              | Interactive wizard mode                                                               | Off                       |

### Dev mode (`--dev`)

Sets up a local development instance with a PostgreSQL container:

```bash
kici-admin orchestrator install --dev
```

This will:

1. Detect Podman or Docker
2. Start a PostgreSQL 18 container on port **15432** (avoids conflicts with existing Postgres)
3. Create an env file with the container's KICI_DATABASE_URL
4. Register the service

The container is named `{service-name}-dev-pg` and can be managed with your container runtime.

## Agent installation

Agent installation follows the same folder-anchored pattern with different configuration. The default `--name` is `kici-agent`, and the manifest filename is `.kici-agent.json`.

```bash
# Wizard mode
kici-admin agent install --wizard --instance-dir ~/kici-agent-deploy

# Flags mode
kici-admin agent install \
  --instance-dir ~/kici-agent-deploy \
  --name kici-agent \
  --orchestrator-url http://orchestrator:4000 \
  --token <agent-token> \
  --labels "os=linux,arch=amd64"
```

Agent-specific flags:

| Flag                       | Description                           |
| -------------------------- | ------------------------------------- |
| `--orchestrator-url <url>` | URL of the orchestrator to connect to |
| `--token <token>`          | Agent authentication token            |
| `--labels <labels>`        | Comma-separated label key=value pairs |

The same `--instance-dir` / `--name` / `--force` flags described above apply to `agent install`. Multiple agents on one host need distinct `--name` and `--instance-dir` values; the create-path guard refuses to clobber a same-named foreign agent unless `--force` is set.

## File locations

All per-instance paths are name-scoped under the listed roots: replace `{name}` with the value of `--name` (defaults to `kici-orchestrator` or `kici-agent`).

### Linux

| Level         | Config root + instance dir | Log root + instance dir            | Systemd unit                            |
| ------------- | -------------------------- | ---------------------------------- | --------------------------------------- |
| System (root) | `/etc/kici/{name}/`        | `/var/log/kici/{name}/`            | `/etc/systemd/system/{name}.service`    |
| User          | `~/.config/kici/{name}/`   | `~/.local/share/kici/{name}/logs/` | `~/.config/systemd/user/{name}.service` |

Instance index: `/etc/kici/instances.json` (system) or `~/.config/kici/instances.json` (user).

### macOS

| Level         | Config root + instance dir                   | Log root + instance dir       | Plist                                          |
| ------------- | -------------------------------------------- | ----------------------------- | ---------------------------------------------- |
| System (root) | `/etc/kici/{name}/`                          | `/var/log/kici/{name}/`       | `/Library/LaunchDaemons/dev.kici.{name}.plist` |
| User          | `~/Library/Application Support/kici/{name}/` | `~/Library/Logs/kici/{name}/` | `~/Library/LaunchAgents/dev.kici.{name}.plist` |

Instance index: `/etc/kici/instances.json` (system) or `~/Library/Application Support/kici/instances.json` (user).

### Windows

| Level  | Config root + instance dir    | Log root + instance dir            |
| ------ | ----------------------------- | ---------------------------------- |
| System | `C:\ProgramData\kici\{name}\` | `C:\ProgramData\kici\{name}\logs\` |
| User   | `%LOCALAPPDATA%\kici\{name}\` | `%LOCALAPPDATA%\kici\{name}\logs\` |

Instance index: `C:\ProgramData\kici\instances.json` (system) or `%LOCALAPPDATA%\kici\instances.json` (user).

### Install base (versioned upgrade tree)

The `upgrade` command extracts each version into a name-scoped directory and flips a symlink:

| Platform         | Install base                    |
| ---------------- | ------------------------------- |
| systemd, compose | `/opt/kici/{name}/`             |
| launchd          | `/usr/local/kici/{name}/`       |
| Windows          | `C:\Program Files\KiCI\{name}\` |

Two instances with different `--name` values therefore have independent versioned trees — upgrading one does not touch the other.

## Service lifecycle commands

Every lifecycle command resolves its target through the same priority chain: `--instance-dir` > `--name` > a manifest in the current working directory. Without any of those, the command refuses and prints the candidate list of installed instances on the host. The examples below use `--instance-dir`; they work identically if you `cd` into the deploy folder first and drop the flag.

### Start

```bash
kici-admin orchestrator start [--instance-dir <path>] [--name <name>] [--platform <type>]
```

### Stop

```bash
kici-admin orchestrator stop [--instance-dir <path>] [--name <name>] [--platform <type>]
```

### Restart

```bash
kici-admin orchestrator restart [--instance-dir <path>] [--name <name>] [--platform <type>]
```

### Status

Shows OS-level service state (running/stopped/failed, PID, uptime) and queries the running orchestrator's health API for KiCI-specific info:

```bash
kici-admin orchestrator status [--instance-dir <path>] [--name <name>] [--json]
```

Example output:

```
Service: kici-orchestrator
State:   running
PID:     12345
Uptime:  2h 15m

--- KiCI orchestrator ---
Mode:       independent
Port:       4000
Database:   connected
Agents:     3
Scaler:     container (warm: 2, max: 10)
Jobs:       0 pending, 1 running
```

Use `--json` for machine-readable output.

### Logs

Tail and follow service logs with filtering:

```bash
# Follow logs (default)
kici-admin orchestrator logs

# Recent logs without follow
kici-admin orchestrator logs --no-follow --since 30m

# Filter by level
kici-admin orchestrator logs --level error

# JSON output
kici-admin orchestrator logs --json --since 1h
```

| Flag                 | Description                                        |
| -------------------- | -------------------------------------------------- |
| `--since <duration>` | Show logs since duration (e.g., `1h`, `30m`, `2d`) |
| `--level <level>`    | Filter: `error`, `warn`, or `info`                 |
| `--json`             | Output as JSON lines                               |
| `--no-follow`        | Don't tail -- print and exit                       |

Platform-specific log sources:

- **Linux**: `journalctl -u {name}` (system) or `journalctl --user-unit {name}` (user)
- **macOS**: log files in the logs directory
- **Windows**: Windows Event Log (`wevtutil`)

## Upgrade procedure

The upgrade uses a **name-scoped versioned directory layout**: each version is extracted under the resolved instance's own install base (e.g. `/opt/kici/<name>/orchestrator-0.3.0/`), and a per-instance symlink (e.g. `/opt/kici/<name>/orchestrator`) points to the active version. This enables instant rollback and keeps previous versions available — and because the install base is name-scoped, upgrading one instance never touches another.

`upgrade` accepts `--instance-dir` and `--name` on the same priority chain as the other lifecycle commands. Run it from inside the deploy folder, or pass `--instance-dir` explicitly:

```bash
# Upgrade from a local archive (target resolved from CWD manifest)
cd ~/kici-deploy
kici-admin orchestrator upgrade --from /path/to/kici-orchestrator-0.3.0.tar.gz --version 0.3.0

# Or pass --instance-dir from anywhere
kici-admin orchestrator upgrade \
  --instance-dir ~/kici-deploy \
  --url https://releases.kici.dev/v0.3.0/kici-orchestrator.tar.gz \
  --version 0.3.0
```

The upgrade command:

1. Resolves the target instance (refuses if no target can be resolved).
2. Extracts the new version under the resolved instance's `<installBase>/<name>/` tree (e.g., `/opt/kici/<name>/orchestrator-0.3.0/`).
3. Stops the running service.
4. Updates the per-instance symlink atomically (Unix) or re-registers the service (Windows).
5. Starts the service with the new version.

Previous versions of the resolved instance are preserved on disk for rollback. Other installed instances are untouched.

### npm-source upgrade (no archive)

For deployments installed from npm, you can upgrade without supplying an archive. First update the global package, then run `upgrade` with no `--from`/`--url`:

```bash
# Upgrade an npm-installed orchestrator to a published version.
# The install unit is the `kici-admin` wrapper — it carries both the
# orchestrator and the agent, and updating it refreshes the copies the
# service unit's ExecStart points at.
npm install -g kici-admin@<version>
kici-admin orchestrator upgrade --version <version> --yes

# The agent flavor uses the same wrapper install
kici-admin agent upgrade --version <version> --yes
```

With no archive source, the upgrade:

1. Validates that the running package version matches `--version` (guarding against an `npm install` that did not actually replace the global binary). Omit `--version` to default to the installed package version.
2. Reads the launch command the installed service unit will actually execute (the `ExecStart` of the systemd unit, the `ProgramArguments` of the launchd plist, or the service binary path on Windows) and resolves the version that launch target will run from the package metadata next to it.
3. Verifies that the resolved launch-target version matches the version of the `kici-admin` you just invoked. Only when they match does it restart the service and record the verified version in the instance manifest.

No archive is downloaded, no versioned directory is created, and no symlink is flipped — the service unit already points at the global npm package, so a restart is all that is needed. The `--from`/`--url` archive flow (versioned directory, symlink, and rollback) is unchanged and remains the path for offline or air-gapped upgrades.

#### Launch-version verification and the mismatch failure

The upgrade resolves the version the service unit will _actually_ launch before it restarts anything or records a version. This catches the case where `npm install -g` updated a different install than the service is pinned to — for example, when several runtimes are managed side by side (mise, nvm, asdf) and the global install landed under a different runtime than the one the unit's launch path points at.

If the version the unit will launch does not match the `kici-admin` you ran, the upgrade aborts **before** stopping the service, leaves the service running, and leaves the instance manifest untouched. The error names both versions and the launch path. Two ways to resolve it:

- Install the new version under the unit's own runtime — the runtime its launch path (`ExecStart` / `ProgramArguments` / service binary) points at — then re-run the upgrade.
- Re-run `kici-admin orchestrator install` (or `kici-admin agent install`) to repoint the unit at the runtime where you installed the new version, then re-run the upgrade.

This is why a refused npm-source upgrade never leaves a "now running version X" message behind a service that is still running the old code: the version is read from the unit's real launch target, not from the binary you happened to type.

#### `--force` for opaque launch targets

When the service was installed with an explicit `--binary` wrapper (or any launch target whose version can't be read), there is no package metadata to resolve, so the verification can't run. Passing `--force` bypasses the launch-target verification and restarts the service onto the installed package. Because the version could not be verified in that case, the upgrade deliberately leaves the manifest's recorded version unchanged rather than guessing. `--force` does not bypass the running-version check in step 1 — if the invoking `kici-admin`'s own version is itself unresolvable, the upgrade still refuses.

The diagnostics page surfaces the latest published version next to each node's running version and reveals exactly this two-line command when an upgrade is available — see [Monitoring & tracing](../observability/monitoring.md).

### Rollback

To roll back the resolved instance to its previous version:

```bash
cd ~/kici-deploy
kici-admin orchestrator upgrade --rollback
```

This stops the service, switches the per-instance symlink to the previous version, and restarts.

### Pick an installed version

To switch to a specific already-installed version (not just the immediately
previous one), use `--pick`:

```bash
cd ~/kici-deploy
kici-admin orchestrator upgrade --pick
```

It lists every installed version, lets you choose one interactively (the active
version is shown but not selectable), prints the change summary, and asks for
confirmation before flipping the symlink / re-registering the service. Like
`--rollback`, `--pick` only switches between versions already extracted under
the instance's install base — it never downloads. It requires an interactive
terminal (for non-interactive switching, use `--rollback` or an explicit
`--from`/`--url` archive).

### Cleanup old versions

To remove old versions (keeps current and previous) of the resolved instance:

```bash
kici-admin orchestrator upgrade --instance-dir ~/kici-deploy --cleanup
```

### Upgrade CLI flags

| Flag                    | Description                                                                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--from <path>`         | Path to package archive (`.tar.gz` or `.zip`)                                                                                                                                                      |
| `--url <url>`           | URL to download package archive from                                                                                                                                                               |
| `--version <ver>`       | Target version string (e.g., `0.3.0`). Required for archive upgrades; for npm-source upgrades it is validated against the installed package and defaults to it when omitted                        |
| `--rollback`            | Roll back the resolved instance to its previous version                                                                                                                                            |
| `--pick`                | Interactively pick an already-installed version to activate (switch, no download). Requires an interactive terminal                                                                                |
| `--cleanup`             | Remove old versions of the resolved instance (keeps current and previous)                                                                                                                          |
| `--force`               | Archive upgrades: overwrite an existing versioned directory. npm-source upgrades: bypass launch-target version verification (for opaque `--binary` installs); restarts without recording a version |
| `--yes`                 | Skip confirmation prompt                                                                                                                                                                           |
| `--platform <type>`     | Force platform (`systemd`, `launchd`, `windows`, `compose`)                                                                                                                                        |
| `--instance-dir <path>` | Deploy folder of the instance to upgrade                                                                                                                                                           |
| `--name <name>`         | Service name (no default — must resolve via flag or CWD manifest)                                                                                                                                  |

### Database migrations during upgrade

The orchestrator auto-migrates its PostgreSQL database on startup (enabled by default). When the new version includes schema changes, migrations run automatically after the service restarts.

If you've disabled auto-migration (`KICI_AUTO_MIGRATE=false`), run migrations manually before the upgrade:

```bash
kici-admin db migrate --status   # Check pending migrations
kici-admin db migrate            # Apply them
```

See [Orchestrator setup — database](../orchestrator/orchestrator-setup.md#database) for details on migration management.

### Cluster upgrade order

In clustered deployments (coordinator + workers), nodes can be upgraded in any order as long as both sides support the same minimum protocol version. When a protocol version bump occurs (documented in release notes), upgrade all nodes. See [Coordinator-worker — upgrade procedure](../../architecture/clustering/coordinator-worker.md#upgrade-procedure) for the full sequence.

### Job recovery during upgrade

Running jobs are not lost during a planned upgrade. Agents reconnect within a 120-second grace period and resume in-flight work. See [Job recovery](../orchestrator/README.md#job-recovery) for details on the recovery protocol and monitoring.

## Uninstall procedure

```bash
kici-admin orchestrator uninstall [--instance-dir <path>] [--name <name>]
```

Uninstall:

- Resolves the target via the same `--instance-dir` / `--name` / CWD-manifest chain as the other lifecycle commands (refuses with a candidate list when no target can be resolved).
- Stops the service if running.
- Removes the service registration (systemd unit, launchd plist, or Windows service entry).
- Drops the host-wide index entry for the instance.
- **Preserves** config files, database, logs, and the on-disk manifest so subsequent commands can still reference the deploy folder if needed.

After uninstalling, you can manually clean up the resolved instance's name-scoped directories:

```bash
# Linux (system)
sudo rm -rf /etc/kici/<name>/ /var/log/kici/<name>/

# Linux (user)
rm -rf ~/.config/kici/<name>/ ~/.local/share/kici/<name>/

# macOS (user)
rm -rf ~/Library/Application\ Support/kici/<name>/ ~/Library/Logs/kici/<name>/

# Windows
rmdir /s C:\ProgramData\kici\<name>
```

The instance index file (`instances.json` directly under each config root) and other instances' directories are left in place.

## Privilege model

The installer auto-detects privilege level:

- **Root/admin** -- installs a system-wide service that runs at boot
- **Regular user** -- installs a user-level service

For Linux user-level services, `loginctl enable-linger` is run automatically so the service survives logout.

### Scaler privilege requirements

Some scaler configurations require elevated privileges:

| Scaler                    | Minimum privilege       |
| ------------------------- | ----------------------- |
| Container (Docker/Podman) | User (rootless) or root |
| Bare-metal                | User                    |
| Firecracker               | **Root required**       |

If you install a user-level service with Firecracker scaler configuration, the installer will warn you.

## Restart policy

Services are configured with automatic restart on failure:

- **Backoff delays**: 1s, 5s, 15s, 30s
- **Maximum retries**: 5 consecutive failures within 5 minutes
- After exceeding the limit, the service stays stopped until manually restarted

This is implemented via:

- systemd: `Restart=on-failure`, `RestartSec`, `StartLimitBurst`, `StartLimitIntervalSec`
- launchd: `KeepAlive` with `SuccessfulExit: false`, `ThrottleInterval`
- Windows: `sc.exe failure` with restart actions

The services distinguish clean stops from fatal failures by exit code: an
intentional shutdown (SIGTERM/SIGINT from a service stop, or an admin-initiated
drain) exits 0 and does not trigger a restart, while a fatal internal error
(an uncaught exception) runs the same graceful teardown but exits non-zero so
the on-failure restart policy brings the service back automatically.

## Firecracker scaler setup

When the orchestrator is configured to use the Firecracker scaler, additional machine setup is required. The installer automates the safe parts and provides instructions for manual steps.

### Automated by the installer

- Download Firecracker and jailer binaries
- Verify `/dev/kvm` is accessible
- Create network bridge
- Set up NAT rules with TCP MSS clamping
- Download kernel and rootfs images

### Manual requirements

- KVM must be enabled in BIOS/firmware
- Kernel 5.10+ with `random.trust_cpu=on` boot argument (critical for TLS in VMs)
- The service must run as root

See `scripts/firecracker/` in the source repository for detailed setup scripts.

## Troubleshooting

### Service won't start

1. Check the env file exists and has valid configuration:
   ```bash
   # Per-instance env path is name-scoped: /etc/kici/<name>/<name>.env
   cat /etc/kici/kici-orchestrator/kici-orchestrator.env
   ```
2. Check logs for errors:
   ```bash
   kici-admin orchestrator logs --instance-dir ~/kici-deploy --no-follow --since 5m --level error
   ```
3. Verify database connectivity:
   ```bash
   kici-admin diagnose
   ```

### "No instance specified and no manifest in CWD"

This refusal means the lifecycle command could not resolve a target. Either `cd` into the deploy folder that contains the manifest, or pass `--instance-dir <path>` / `--name <name>` explicitly. The error message lists every installed instance on the host with its deploy folder; use one of those values.

### "exists in the init system but has no manifest"

`--name` found the unit in the init system but could not locate its deploy folder. This happens only for a unit installed before the deploy folder was embedded in the service definition, when the instance index has also been lost. Recover by passing `--instance-dir <deploy folder>` once — for an upgrade, `kici-admin orchestrator upgrade --instance-dir <path>` regenerates the unit with the embedded marker, after which `--name` resolves on its own and the index self-heals. Units installed normally embed the marker, so they recover automatically even with an empty index.

### Permission denied

- System-level operations require root/admin
- Ensure the service user has read access to the config file
- Firecracker scaler requires root -- don't install as user-level

### Port already in use

Change the port in the env file (`KICI_PORT=4001`) and restart:

```bash
kici-admin orchestrator restart
```

### User-level service dies on logout (Linux)

Ensure linger is enabled:

```bash
loginctl enable-linger $(whoami)
```

This is done automatically during install, but can be undone if system settings change.

### Windows service fails to start

1. Check Windows Event Log: Event Viewer > Windows Logs > Application
2. Verify shawl was downloaded: check `%LOCALAPPDATA%\kici\deps\` or `C:\ProgramData\kici\deps\`
3. Ensure the binary path doesn't contain spaces without proper quoting
