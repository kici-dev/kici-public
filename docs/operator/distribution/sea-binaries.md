---
title: KiCI packaging guide
description: ''
---

This guide covers building, distributing, and using KiCI packages for deployment.

## Package types

KiCI produces two types of packages:

- **Full packages** -- Include the Node.js runtime binary, CJS bundle, and launcher script. No Node.js installation needed on the target machine.
- **Light packages** -- Include only the CJS bundle and launcher script. Require a Node.js binary to be cached on the target machine.

KiCI packages four executables:

| Component                      | Purpose                                               |
| ------------------------------ | ----------------------------------------------------- |
| `kici-orchestrator`            | Orchestrator server (platform/hybrid mode)            |
| `kici-orchestrator-standalone` | Orchestrator server (independent mode)                |
| `kici-admin`                   | CLI for managing services, secrets, and configuration |
| `kici-agent`                   | Agent for executing workflow jobs                     |

## Target platforms

Each component is packaged for 6 platform/architecture combinations:

| Platform | Architecture          | Archive format | Launcher extension |
| -------- | --------------------- | -------------- | ------------------ |
| Linux    | x64 (amd64)           | .tar.gz        | (none)             |
| Linux    | arm64 (aarch64)       | .tar.gz        | (none)             |
| macOS    | x64 (Intel)           | .tar.gz        | (none)             |
| macOS    | arm64 (Apple Silicon) | .tar.gz        | (none)             |
| Windows  | x64                   | .zip           | .cmd               |
| Windows  | arm64                 | .zip           | .cmd               |

## Building packages

### Prerequisites

- Node.js 24 LTS
- pnpm (workspace dependencies must be installed)

### Build command

```bash
node scripts/package.mjs [options]
```

Options:

| Flag                   | Description                                       | Default           |
| ---------------------- | ------------------------------------------------- | ----------------- |
| `--target <name>`      | Build a specific target (e.g., `kici-admin`)      | All targets       |
| `--platform <plat>`    | Build for a specific platform (e.g., `linux-x64`) | All platforms     |
| `--light`              | Build only light packages (no Node binary)        | Both types        |
| `--full`               | Build only full packages (with Node binary)       | Both types        |
| `--output-dir <path>`  | Output directory for packages                     | `dist/packages/`  |
| `--node-version <ver>` | Node.js version to embed                          | Current runtime   |
| `--version <ver>`      | Package version string                            | From package.json |

### Examples

```bash
# Build all targets for all platforms (full + light)
node scripts/package.mjs

# Build only kici-admin for Linux x64
node scripts/package.mjs --target kici-admin --platform linux-x64

# Build light packages only (smaller, faster transfers)
node scripts/package.mjs --light

# Custom output directory
node scripts/package.mjs --output-dir ./release/
```

### Build pipeline

The packaging script follows a 4-step process:

1. **Bundle** -- The bundler combines all TypeScript/JavaScript into a single CJS file with tree-shaking
2. **Download Node binary** (full packages only) -- Downloads the official Node.js binary from nodejs.org with SHA-256 verification, cached locally at `~/.cache/kici/node-binaries/`
3. **Assemble package** -- Creates the package directory with the CJS bundle, launcher script, and optionally the Node binary
4. **Create archive** -- Produces .tar.gz (Unix) or .zip (Windows) archive

### pnpm shortcuts

```bash
pnpm package                    # All targets, all platforms
pnpm package:linux-x64          # All targets, Linux x64
pnpm package:linux-arm64        # All targets, Linux ARM64
pnpm package:darwin-x64         # All targets, macOS Intel
pnpm package:darwin-arm64       # All targets, macOS Apple Silicon
pnpm package:win-x64            # All targets, Windows x64
pnpm package:win-arm64          # All targets, Windows ARM64
```

## Cross-platform builds

Unlike SEA binaries (which must be built on the target platform), KiCI packages can be built from any machine for any platform. The Node.js binary for the target platform is downloaded from nodejs.org automatically.

```bash
# Build macOS ARM64 packages from a Linux machine
node scripts/package.mjs --platform darwin-arm64

# Build Windows packages from a Linux machine
node scripts/package.mjs --platform win-x64
```

## Package structure

### Full package

```
kici-admin-{version}-linux-x64/
  kici-admin            # Launcher script (shell or .cmd)
  bin/node              # Node.js binary
  lib/kici-admin.cjs    # Bundled application
```

The launcher executes the CJS bundle using the bundled Node binary.

### Light package

```
kici-admin-{version}-linux-x64-light/
  kici-admin            # Launcher script (shell or .cmd)
  lib/kici-admin.cjs    # Bundled application
```

The launcher looks for a cached Node.js binary at:

- **Linux/macOS:** `$XDG_CACHE_HOME/kici/node-binaries/v{VERSION}/bin/node` (default: `~/.cache/...`)
- **Windows:** `%LOCALAPPDATA%\kici\node-binaries\v{VERSION}\node.exe`

If the Node binary is not found, the launcher prints an error with download instructions.

## Package size

- **Full packages:** ~30-40 MB per archive (Node binary ~80 MB + bundle ~15-30 MB, compressed)
- **Light packages:** ~5-10 MB per archive (bundle only)

Light packages are ideal for repeated deployments where the Node binary is already cached on the target machine.

## Native addon handling

Some dependencies use native addons (C/C++ bindings compiled to `.node` files):

- `pg-native` (optional PostgreSQL driver)
- `better-sqlite3` (optional SQLite driver)
- `cpu-features` (optional CPU detection)

These are **excluded from the bundle** because native addons cannot be inlined. Instead:

- The pure-JavaScript fallback is used where available (e.g., `pg` uses JS by default, `pg-native` is optional)
- If a native addon is needed, it must be placed alongside the package as a `.node` file

For most deployments, the pure-JS fallbacks work correctly and no additional files are needed.

## Distribution

### Hosting recommendations

KiCI packages can be hosted on:

- **GitHub Releases** -- attach archives to tagged releases
- **CDN** (e.g., CloudFront, Cloudflare R2) -- for fast global distribution
- **Object storage** (e.g., S3, SeaweedFS) -- for self-hosted deployments
- **Package managers** -- Homebrew formula, winget manifest, apt/rpm packages

### Naming convention

```
{target}-{version}-{os}-{arch}[-light].{tar.gz|zip}
```

Examples:

```
kici-orchestrator-0.1.0-linux-x64.tar.gz
kici-orchestrator-0.1.0-linux-arm64-light.tar.gz
kici-admin-0.1.0-darwin-arm64.tar.gz
kici-agent-0.1.0-win-x64.zip
```

## Verification

### Check package works

```bash
# Extract and run (full package)
tar xzf kici-admin-0.1.0-linux-x64.tar.gz
./kici-admin-0.1.0-linux-x64/kici-admin --help

# Light package (requires Node cached)
tar xzf kici-admin-0.1.0-linux-x64-light.tar.gz
./kici-admin-0.1.0-linux-x64-light/kici-admin --help
```

### Verify integrity

When distributing packages, provide SHA-256 checksums:

```bash
# Generate checksums
sha256sum dist/packages/*.tar.gz dist/packages/*.zip > checksums.sha256

# Verify a downloaded package
sha256sum -c checksums.sha256
```
