---
title: Environment variables
description: KICI_* environment variable reference for the CLI
---

The KiCI CLI reads the following environment variables to customize its behavior. OAuth login (`kici login` without `--token`) defaults `KICI_PLATFORM_URL`, `KICI_OIDC_ISSUER`, and `KICI_OIDC_CLIENT_ID` to the hosted KiCI Platform, so `kici login` works with no configuration. Set them only to target a self-hosted Platform or a testing environment.

## Authentication

| Variable              | Description                            | Default                                      |
| --------------------- | -------------------------------------- | -------------------------------------------- |
| `KICI_OIDC_ISSUER`    | OIDC issuer URL for authentication     | `https://auth.kici.dev/realms/kici-internal` |
| `KICI_OIDC_CLIENT_ID` | OIDC client ID for the CLI application | `kici-cli`                                   |
| `KICI_PLATFORM_URL`   | Platform API base URL                  | `https://api.kici.dev`                       |
| `KICI_CONFIG_DIR`     | Override the KiCI config directory     | `~/.kici`                                    |

## Browser behavior

| Variable             | Description                                                                                                                                          | Default                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `KICI_BROWSER_CMD`   | Custom browser command for OAuth login. Supports `{url}` placeholder. Set to `none` to suppress browser opening and print the URL to stdout instead. | Uses the system default browser via the `open` package |
| `KICI_CALLBACK_PORT` | Fixed port for the OAuth PKCE callback server. Useful when firewall rules require a known port.                                                      | Random available port                                  |

## Development

| Variable     | Description                                                                                                                                                                | Default |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `KICI_DEV`   | Enable development mode. When `true`, uses prerelease-compatible version ranges (`>=0.0.1-0`) for dev dependencies and skips npm version resolution.                       | unset   |
| `KICI_DEBUG` | Enable debug logging. When `true`, prints verbose diagnostics (SDK alias resolution, step-level debug logs, stack traces on errors). Equivalent to the `--debug` CLI flag. | unset   |

## Usage examples

### CI/CD environment

Authenticate with a pre-existing API key (no browser needed):

```bash
kici login --token <<< "$KICI_API_KEY"
```

### Self-hosted Platform or custom OIDC provider

`kici login` targets the hosted KiCI Platform by default. To point the CLI at a self-hosted Platform or a testing OIDC provider, override the defaults:

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
