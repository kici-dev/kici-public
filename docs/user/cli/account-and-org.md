---
title: 'kici: account & org'
description: 'Login, org selection, personal access tokens, secrets, and admin'
---

## Guide

### kici login

Authenticate with KiCI via browser-based OAuth (default) or API key (`--token`).

By default, `kici login` opens your browser for OIDC authentication using PKCE. In headless environments (SSH, CI, containers), it automatically switches to the RFC 8628 device authorization flow where you visit a URL and enter a code.

The browser flow completes by receiving a callback on `127.0.0.1`. If that callback is blocked, pass `--device` to use the device flow instead — it needs no local callback. See [CLI authentication](../cli-auth.md#browser-callback-never-arrives) for the full troubleshooting steps.

After OAuth, the CLI exchanges the OIDC token for a personal access token (PAT) stored in the config directory (`~/.kici/config` by default, overridable with `KICI_CONFIG_DIR`).

`kici login` targets the hosted KiCI Platform by default. To authenticate against another KiCI environment (staging, or a testing OIDC provider, for example), pass `--platform-endpoint` / `--oidc-issuer` or set `KICI_PLATFORM_URL` / `KICI_OIDC_ISSUER`. Login persists the platform endpoint and OIDC issuer it authenticated against alongside the PAT, so a saved PAT always matches its endpoint. Because the config describes one environment at a time, **switching the endpoint resets the active organization and default clusters** — re-run `kici org use <name>` after switching environments.

```bash
kici login [options]
```

**Environment variables:**

| Variable              | Default                                      | Description                                                            |
| --------------------- | -------------------------------------------- | ---------------------------------------------------------------------- |
| `KICI_PLATFORM_URL`   | `https://api.kici.dev`                       | Platform API base URL (override to target another KiCI environment)    |
| `KICI_OIDC_ISSUER`    | `https://auth.kici.dev/realms/kici-internal` | OIDC issuer URL (override to target another KiCI environment)          |
| `KICI_OIDC_CLIENT_ID` | `kici-cli`                                   | OIDC client ID (override to target another KiCI environment)           |
| `KICI_BROWSER_CMD`    | uses `open` package                          | Custom browser command with `{url}` placeholder, or `none` to suppress |
| `KICI_CALLBACK_PORT`  | random                                       | Fixed port for OAuth PKCE callback server                              |
| `KICI_CONFIG_DIR`     | `~/.kici`                                    | Override config directory                                              |

**Examples:**

```bash
# Browser-based OAuth login (default)
kici login

# Force device flow (for SSH/headless)
kici login --device

# Legacy API key login
kici login --token kici_sk_abc123...

# Log in against another KiCI environment (e.g. a testing instance)
kici login --platform-endpoint https://platform.example.com \
  --oidc-issuer https://auth.example.com/realms/kici-internal

# Suppress browser opening (print authorize URL to stdout)
KICI_BROWSER_CMD=none kici login

# Use custom browser command
KICI_BROWSER_CMD='firefox {url}' kici login

# Fixed callback port and custom config directory
KICI_CALLBACK_PORT=19876 KICI_CONFIG_DIR=/tmp/kici-test kici login
```

**Headless detection:** The CLI checks, in order:

1. SSH session — `SSH_CONNECTION`, `SSH_CLIENT`, or `SSH_TTY` set.
2. CI — `CI`, `GITHUB_ACTIONS`, or `GITLAB_CI` set to anything other than the explicit opt-outs `0` and `false` (any case), so exporting `CI=0` on a desktop keeps the browser flow. An opt-out cancels that one marker only — `CI=false GITHUB_ACTIONS=true` still selects the device flow, and `GITHUB_ACTIONS=false` opts that marker out without affecting `CI`. See [Environment variables](../env-vars.md#how-ci-is-interpreted) for the full convention.
3. Container — `container` or `DOCKER_CONTAINER` set, or the `/run/.containerenv` / `/.dockerenv` sentinel files present.
4. WSL — an interactive desktop, so **not** headless, but only when Windows interop is reachable: the browser flow opens your Windows browser and the localhost callback is normally reachable through WSL's localhost forwarding (a `portproxy` rule or firewall policy can still block it — pass `--device` if it does). When interop is unreachable (it is disabled, or the Windows drive is not mounted) no Windows browser can be launched, so WSL counts as headless and the device flow is used. The same applies when the interop check does not answer within a couple of seconds — the signature of a hung Windows drive mount — so a wedged mount falls back to the device flow instead of stalling the login.
5. Linux without a display server — neither `DISPLAY` nor `WAYLAND_DISPLAY` set.

The first match wins, so an SSH session into WSL, or a container running on a WSL host, stays on the device flow.

### kici logout

Revoke your personal access token on the server and clear local credentials.

If the server is unreachable, local credentials are still cleared (the PAT will expire automatically). Non-auth config fields (active org, default clusters, etc.) are preserved.

```bash
kici logout
```

**Examples:**

```bash
# Log out and revoke PAT
kici logout
```

### kici init

Initialize a `.kici/` directory with default workflow templates.

```bash
kici init [options]
```

**Examples:**

```bash
# Interactive initialization
kici init

# Overwrite existing setup
kici init --force

# Skip dependency install (faster, install manually later)
kici init --skip-install

# Force a specific package manager (default: detect from your repo)
kici init --package-manager pnpm

# JavaScript mode (no TypeScript)
kici init --mjs

# Integrate into the surrounding workspace (workflows can import sibling packages)
kici init --workspace

# Force a self-contained .kici/ even inside a workspace
kici init --standalone

# Skip writing the AGENTS.md LLM authoring context file
kici init --no-agents-md

# Scaffold a workflow registries entry for a private npm registry
kici init --private-registry https://npm.pkg.github.com/ \
          --private-registry-scope @my-org \
          --private-registry-secret production:GITHUB_PACKAGES_TOKEN
```

**What it creates:**

```
.kici/
  workflows/
    hello-world.ts    # Minimal push workflow
    pr-checks.ts      # Comprehensive PR workflow
  tests/
    push-test.ts      # Sample test fixture
  types/              # Directory for generated type declarations (kici types)
  package.json        # Dependencies (@kici-dev/sdk)
  tsconfig.json       # TypeScript configuration (includes types/**/*.d.ts)
  AGENTS.md           # LLM authoring context (skip with --no-agents-md)
.kiciignore           # Default exclusion patterns for test uploads
```

`AGENTS.md` is written by default (the interactive prompt defaults to yes, and CI / non-interactive runs write it). An existing `.kici/AGENTS.md` is never overwritten, so hand edits survive a re-run.

In interactive mode (TTY), `kici init` prompts you to:

1. Select which workflow templates to include
2. Optionally install a pre-commit hook

**Host-OS runsOn:** the scaffolded workflows target `kici:os:<your OS>` — `kici init` detects the host operating system (like it detects the default branch) and writes `kici:os:linux`, `kici:os:macos`, or `kici:os:windows` so your very first `kici run push --local` dispatches on this machine. A workflow authored on one OS and run locally on another prints a hint naming the OS it wants versus the host it found.

**First run:** in interactive mode, after setup `kici init` offers to run the scaffolded workflow immediately (`kici run push --local`), defaulting to No. It is skipped in CI, non-interactive shells, `--mjs`, and `--skip-install` (where dependencies are not installed yet).

**Package manager:** the dependency install step uses the package manager detected for your repo — the `packageManager` field in the nearest `package.json` (Corepack convention), then a lockfile in the project root (`pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm), then the package manager that invoked `kici` (`pnpm dlx` / `yarn dlx` / `npx`), defaulting to npm. Pass `--package-manager <npm|pnpm|yarn>` to override detection, or `--skip-install` to set up the files and install later yourself.

**Standalone vs workspace integration:** by default `kici init` scaffolds a self-contained `.kici/` with its own `package.json`. When run inside a pnpm, npm, or yarn workspace, it offers an **integrate** option (or pass `--workspace`): `.kici/` joins the workspace, `@kici-dev/sdk` is added to your workspace-root `package.json`, and your workflows can `import` your other workspace packages (e.g. shared build or deploy utilities). In this mode there is no `.kici/package.json` — the workspace root manages dependencies, and the root install resolves the SDK. Your workflows resolve sibling packages through the workspace-root `node_modules`: under npm and yarn every workspace member is hoisted there automatically, while pnpm links only your root's declared dependencies, so under pnpm add the package you want to import to your workspace-root `dependencies` (this is how KiCI's own repository imports its packages from workflows). Pass `--standalone` to force the self-contained layout even inside a workspace. In CI / non-interactive runs the default is standalone; use `--workspace` to opt in explicitly. `--workspace` and `--standalone` are mutually exclusive, and `--workspace` errors if no workspace is found at or above the current directory.

**Development mode:** When `KICI_DEV=true` or `package.json` has `"kici": { "development": true }`, the generated `package.json` uses prerelease-compatible version ranges (`>=0.0.1-0`) so npm resolves Verdaccio's prerelease builds.

### kici org

Manage organization context. Requires a PAT (run `kici login` first).

#### kici org list

List organizations you belong to. The active org is marked with a star (`*`).

```bash
kici org list
```

**Example output:**

```
Organizations:

  * Personal          (owner)  abc123def456
    My team           (admin)  xyz789ghi012
```

#### kici org use

Switch the active organization by name (case-insensitive) or ID.

```bash
kici org use <name>
```

**Examples:**

```bash
# Switch by name
kici org use "My team"

# Switch by ID
kici org use xyz789ghi012
```

#### kici org current

Show the current active organization.

```bash
kici org current
```

### kici pat create

Mint a personal access token under your own identity. Pass `--agent` to mint an
**agent-kind** PAT — the credential a coding agent points the KiCI MCP server at.

```bash
kici pat create --agent --name "claude-code"
```

- `--agent` marks the token as agent-kind. An agent PAT inherits your
  permissions unchanged (it carries provenance, not extra authority) and is the
  **only** credential the MCP server accepts.
- `--name <label>` sets the token name. For an agent PAT this is the **agent
  label** recorded on every action the agent takes — required with `--agent`.
- `--expires-in-days <n>` overrides the default expiry.

The token is printed once — save it immediately; it cannot be retrieved later.
See [Drive KiCI from your coding agent](../ai-agents.md) for the full setup.

**Prerequisites:** authenticate via `kici login` first.

### kici secrets list

List secret contexts available for test runs. Shows context names and key names (not values).

```bash
kici secrets list
```

Each context corresponds to a context configured on the orchestrator. The output lists every context whose `allowLocalExecution` flag is `true` (the gate that lets CLI-initiated test runs resolve secrets through that context), along with the secret key names reachable from the context's bound scopes.

Only key names are shown — secret values are never returned over this endpoint.

**Prerequisites:** authenticate via `kici login` and select an active organization with `kici org use <name>`.

### kici admin

Operator-facing commands for running instances.

#### kici admin drain-worker

Trigger graceful drain on a worker instance. Sends a POST request to the worker's `/drain` endpoint.

```bash
kici admin drain-worker [options]
```

**Examples:**

```bash
# Drain a local worker
kici admin drain-worker --url http://localhost:10143

# Drain a remote worker
kici admin drain-worker --url http://worker-2.internal:10143
```

**Exit codes:**

| Code | Meaning                             |
| ---- | ----------------------------------- |
| 0    | Drain request accepted              |
| 1    | Error (unreachable or request fail) |

### kici endpoints

List all webhook entrypoints for the current project. Reads the compiled lock file and displays webhook URLs grouped by type (git provider, generic webhooks, scheduled, event-driven).

```bash
kici endpoints [options]
```

**Prerequisites:** Run `kici compile` first to generate the lock file.

**Examples:**

```bash
# List all webhook entrypoints
kici endpoints

# Custom .kici directory
kici endpoints --kici-dir packages/app/.kici
```

## Reference

<!-- BEGIN GENERATED: kici-account-and-org (do not edit; run the doc generator) -->

### `kici admin`

Operator-facing commands for running instances

Synopsis: `kici admin`

### `kici admin drain-worker`

Trigger graceful drain on a worker instance

Synopsis: `kici admin drain-worker [options]`

**Options**

| Option        | Default | Description                                  |
| ------------- | ------- | -------------------------------------------- |
| `--url <url>` |         | Worker URL (e.g., http://worker-host:<port>) |

### `kici endpoints`

List all webhook entrypoints for the current project

Synopsis: `kici endpoints [options]`

**Options**

| Option              | Default | Description             |
| ------------------- | ------- | ----------------------- |
| `--kici-dir <path>` | `.kici` | Path to .kici directory |

### `kici init`

Initialize .kici/ directory with default workflows

Synopsis: `kici init [options]`

**Options**

| Option                             | Default                | Description                                                                                         |
| ---------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------- |
| `--force`                          | `false`                | Overwrite existing .kici/ directory                                                                 |
| `--skip-install`                   | `false`                | Create files without installing dependencies                                                        |
| `--package-manager <npm            | pnpm                   | yarn>`                                                                                              |     | Force a package manager for the install step (default: auto-detect) |
| `--mjs`                            | `false`                | JavaScript-only mode (no TypeScript, no dependencies)                                               |
| `--workspace`                      | `false`                | Integrate .kici/ into the detected pnpm/npm/yarn workspace so workflows can import sibling packages |
| `--standalone`                     | `false`                | Force a self-contained .kici/ even inside a workspace                                               |
| `--no-agents-md`                   |                        | Skip writing .kici/AGENTS.md (LLM authoring context)                                                |
| `--private-registry <url>`         |                        | Scaffold a workflow registries: entry pointing at <url>                                             |
| `--private-registry-scope <scope>` |                        | Optional npm package scope (e.g. @my-org) for the private registry                                  |
| `--private-registry-secret <ref>`  | `production:NPM_TOKEN` | Qualified secret reference (env:NAME) the private registry token comes from                         |

### `kici login`

Authenticate with KiCI via browser OAuth (default) or API key (--token)

Synopsis: `kici login [options]`

**Options**

| Option                      | Default | Description                                                                         |
| --------------------------- | ------- | ----------------------------------------------------------------------------------- |
| `--token <key>`             |         | API key for direct authentication (legacy)                                          |
| `--device`                  |         | Force device authorization flow (for headless/SSH environments)                     |
| `--platform-endpoint <url>` |         | Platform relay URL                                                                  |
| `--oidc-issuer <url>`       |         | OIDC issuer URL (defaults to the hosted KiCI IdP unless a flag/env selects another) |
| `--routing-key <key>`       |         | Routing key for webhook source identification                                       |
| `--no-attach`               |         | Skip the post-login prompt to attach the local dev plane                            |

### `kici logout`

Revoke PAT and clear local credentials

Synopsis: `kici logout`

### `kici orchestrators`

Inspect the org's orchestrator clusters and pick a default for run remote

Synopsis: `kici orchestrators`

### `kici orchestrators list`

List the connected orchestrator clusters for the active org

Synopsis: `kici orchestrators list [options]`

**Options**

| Option       | Default | Description                                    |
| ------------ | ------- | ---------------------------------------------- |
| `--org <id>` |         | Target organization (overrides the active org) |

### `kici orchestrators use`

Set the per-org default orchestrator cluster for run remote

Synopsis: `kici orchestrators use <name> [options]`

**Arguments**

| Argument | Required | Variadic | Description               |
| -------- | -------- | -------- | ------------------------- |
| `name`   | yes      | no       | Orchestrator cluster name |

**Options**

| Option       | Default | Description                                    |
| ------------ | ------- | ---------------------------------------------- |
| `--org <id>` |         | Target organization (overrides the active org) |

### `kici org`

Manage organizations

Synopsis: `kici org`

### `kici org current`

Show current active organization

Synopsis: `kici org current`

### `kici org list`

List organizations you belong to

Synopsis: `kici org list`

### `kici org use`

Switch active organization

Synopsis: `kici org use <name>`

**Arguments**

| Argument | Required | Variadic | Description             |
| -------- | -------- | -------- | ----------------------- |
| `name`   | yes      | no       | Organization name or ID |

### `kici pat`

Manage personal access tokens

Synopsis: `kici pat`

### `kici pat create`

Mint a personal access token (use --agent for a coding-agent token)

Synopsis: `kici pat create [options]`

**Options**

| Option                  | Default | Description                                    |
| ----------------------- | ------- | ---------------------------------------------- |
| `--name <name>`         |         | Token name (defaults to the agent label)       |
| `--agent`               | `false` | Mint an agent-kind PAT for the KiCI MCP server |
| `--expires-in-days <n>` |         | Custom expiry in days                          |

### `kici secrets`

Manage secrets

Synopsis: `kici secrets`

### `kici secrets list`

List test-available secret contexts

Synopsis: `kici secrets list`
<!-- END GENERATED: kici-account-and-org -->
