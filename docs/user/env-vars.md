---
title: Environment variables
description: Environment variable reference for the CLI
---

The KiCI CLI reads the following environment variables to customize its behavior. OAuth login (`kici login` without `--token`) defaults `KICI_PLATFORM_URL`, `KICI_OIDC_ISSUER`, and `KICI_OIDC_CLIENT_ID` to the hosted KiCI Platform, so `kici login` works with no configuration. Set them only to target another KiCI environment (e.g. a testing instance) or a custom OIDC provider.

## Authentication

| Variable              | Description                            | Default                                      |
| --------------------- | -------------------------------------- | -------------------------------------------- |
| `KICI_OIDC_ISSUER`    | OIDC issuer URL for authentication     | `https://auth.kici.dev/realms/kici-internal` |
| `KICI_OIDC_CLIENT_ID` | OIDC client ID for the CLI application | `kici-cli`                                   |
| `KICI_PLATFORM_URL`   | Platform API base URL                  | `https://api.kici.dev`                       |
| `KICI_CONFIG_DIR`     | Override the KiCI config directory     | `~/.kici`                                    |

## Browser behavior

| Variable             | Description                                                                                                                                          | Default                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `KICI_BROWSER_CMD`   | Custom browser command for OAuth login. Supports `{url}` placeholder. Set to `none` to suppress browser opening and print the URL to stdout instead. | Uses the system default browser |
| `KICI_CALLBACK_PORT` | Fixed port for the OAuth PKCE callback server. Useful when firewall rules require a known port.                                                      | Random available port           |

## Development

| Variable     | Description                                                                                                                                                                | Default |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `KICI_DEV`   | Enable development mode. When `true`, uses prerelease-compatible version ranges (`>=0.0.1-0`) for dev dependencies and skips npm version resolution.                       | unset   |
| `KICI_DEBUG` | Enable debug logging. When `true`, prints verbose diagnostics (SDK alias resolution, step-level debug logs, stack traces on errors). Equivalent to the `--debug` CLI flag. | unset   |

## Local dev plane

Read by the [local dev plane](./cli/authoring-and-local.md#kici-local) that `kici run <event> --local` dispatches through.

| Variable                           | Description                                                                                                                                                                         | Default              |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `KICI_LOCAL_ORCH_PORT`             | Port the plane orchestrator listens on (HTTP + WebSocket). Change it when another process already holds the default.                                                                | `4319`               |
| `KICI_LOCAL_PG_PORT`               | Port the plane's PostgreSQL listens on.                                                                                                                                             | `45432`              |
| `KICI_LOCAL_PG_MODE`               | Set to `podman` to force the container PostgreSQL fallback instead of the embedded binary.                                                                                          | Embedded PostgreSQL  |
| `KICI_LOCAL_ACCEPTANCE_TIMEOUT_MS` | How long a local run waits for an agent to claim its first job before failing fast. Raise it on a slow host; the run still fails quickly when no scaler label set matches `runsOn`. | `120000` (2 minutes) |

## CI detection

The CLI also reads the conventional CI markers your CI provider sets. They are not KiCI variables — KiCI only consumes them.

| Variable         | Description                                  | Default |
| ---------------- | -------------------------------------------- | ------- |
| `CI`             | Generic CI marker. Set by most CI providers. | unset   |
| `GITHUB_ACTIONS` | Set to `true` by GitHub Actions.             | unset   |
| `GITLAB_CI`      | Set to `true` by GitLab CI/CD.               | unset   |

### How `CI` is interpreted

`kici` treats the environment as CI when `CI`, `GITHUB_ACTIONS`, or `GITLAB_CI` is set to any value other than an explicit opt-out. `0` and `false` are the opt-outs, compared case-insensitively, so `CI=0`, `CI=false`, and `CI=False` all mean "not CI". Surrounding whitespace is ignored, and a value that is empty or only whitespace (`CI=`) is treated as unset.

A vendor marker outranks the generic opt-out: `CI=false GITHUB_ACTIONS=true` is still CI, because an explicit vendor marker names a real runner rather than a preference.

This affects which login flow `kici login` chooses (browser vs device) and whether interactive commands such as `kici init` prompt.

## Usage examples

### CI/CD environment

Authenticate with a pre-existing API key (no browser needed):

```bash
kici login --token "$KICI_API_KEY"
```

### Targeting another environment or custom OIDC provider

`kici login` targets the hosted KiCI Platform by default. To point the CLI at another KiCI environment (e.g. a testing instance) or a custom OIDC provider, override the defaults:

```bash
export KICI_OIDC_ISSUER=https://your-idp.example.com
export KICI_OIDC_CLIENT_ID=your-client-id
export KICI_PLATFORM_URL=https://your-platform.example.com
kici login
```

### Headless SSH session

The CLI auto-detects headless environments and uses the device flow. To force PKCE with URL output instead:

```bash
export KICI_BROWSER_CMD=none
kici login
```

This prints the authorization URL to stdout as `KICI_AUTH_URL=<url>`. Open the URL in any browser to complete authentication.

### Fixed callback port

When behind a firewall or using port forwarding:

```bash
export KICI_CALLBACK_PORT=19876
kici login
```

### Custom config location

Store the KiCI config in a non-default location:

```bash
export KICI_CONFIG_DIR=/tmp/kici-test
kici login
```
