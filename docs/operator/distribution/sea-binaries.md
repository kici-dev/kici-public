---
title: KiCI packaging guide
description: Download, verify and run the full and light KiCI packages for each supported platform
---

Every KiCI release publishes standalone packages of its components. Use them where npm is not available, or where you do not want to install Node.js.

## Package types

- **Full packages** include the Node.js runtime with its npm, the application bundle and a launcher script. The target machine needs no Node.js or npm installation.
- **Light packages** include only the application bundle and a launcher script. They run on a Node.js runtime cached on the target machine (see [Light package](#light-package)).

KiCI packages these components:

| Component                      | Purpose                                               |
| ------------------------------ | ----------------------------------------------------- |
| `kici-orchestrator`            | Orchestrator server (platform/hybrid mode)            |
| `kici-orchestrator-standalone` | Orchestrator server (independent mode)                |
| `kici-admin`                   | CLI for managing services, secrets, and configuration |
| `kici-agent`                   | Agent for executing workflow jobs                     |

## Target platforms

Each component is packaged for these platforms:

| Platform | Architecture          | Platform name  | Archive format | Launcher extension |
| -------- | --------------------- | -------------- | -------------- | ------------------ |
| Linux    | x64 (amd64)           | `linux-x64`    | .tar.gz        | (none)             |
| Linux    | arm64 (aarch64)       | `linux-arm64`  | .tar.gz        | (none)             |
| macOS    | x64 (Intel)           | `darwin-x64`   | .tar.gz        | (none)             |
| macOS    | arm64 (Apple Silicon) | `darwin-arm64` | .tar.gz        | (none)             |
| Windows  | x64                   | `win-x64`      | .zip           | .cmd               |
| Windows  | arm64                 | `win-arm64`    | .zip           | .cmd               |

## Download a package

Each release attaches every package to its [GitHub release](https://github.com/kici-dev/kici-public/releases), with a `SHA256SUMS` file that holds the checksum of each package. The release notes name the Node.js version of the packages. A package name has this form:

```
{component}-{version}-{platform}[-light].{tar.gz|zip}
```

For example, `kici-agent-{version}-linux-x64.tar.gz` is the full agent package for Linux x64, and `kici-admin-{version}-win-x64-light.zip` is the light `kici-admin` package for Windows x64. [Release artifacts](release-artifacts.md) gives the commands for the current release.

Always verify a package before you extract it. Do not use a package that fails the check.

### Linux and macOS

Set `VERSION` to the KiCI version and `PKG` to the package you need:

```bash
VERSION=<version>
PKG=kici-agent-$VERSION-linux-x64.tar.gz
BASE=https://github.com/kici-dev/kici-public/releases/download/v$VERSION

curl -fsSLO "$BASE/$PKG"
curl -fsSLO "$BASE/SHA256SUMS"
grep " $PKG\$" SHA256SUMS | sha256sum -c -
tar -xzf "$PKG"
```

On macOS, use `shasum -a 256 -c -` in place of `sha256sum -c -`. The check prints `OK` for a correct package.

### Windows

In PowerShell:

```powershell
$version = '<version>'
$pkg = "kici-agent-$version-win-x64.zip"
$base = "https://github.com/kici-dev/kici-public/releases/download/v$version"

Invoke-WebRequest "$base/$pkg" -OutFile $pkg
Invoke-WebRequest "$base/SHA256SUMS" -OutFile SHA256SUMS
$expected = ((Select-String -Path SHA256SUMS -SimpleMatch "  $pkg").Line -split ' ')[0]
if ((Get-FileHash $pkg -Algorithm SHA256).Hash -ne $expected) { throw "Checksum mismatch for $pkg" }
Expand-Archive $pkg -DestinationPath .
```

The GitHub release page also shows the SHA-256 digest of each file.

## Package structure

### Full package

```
kici-admin-{version}-linux-x64/
  kici-admin              # Launcher script
  bin/node                # Node.js binary
  bin/npm, bin/npx        # npm launchers
  lib/kici-admin.cjs      # Bundled application
  lib/node_modules/npm/   # npm, from the Node.js archive
  LICENSE                 # License of the component
  LICENSES.md             # How the KiCI packages are licensed
  THIRD-PARTY-NOTICES     # Licenses of the software bundled into the package
  SOURCE                  # Where to get the source code of this release
  NODE-LICENSE            # License of Node.js and its npm
```

A Windows package keeps npm beside `node.exe`, as the official Node.js zip does:

```
kici-admin-{version}-win-x64/
  kici-admin.cmd          # Launcher script
  bin/node.exe            # Node.js binary
  bin/npm.cmd, bin/npx.cmd
  bin/node_modules/npm/   # npm, from the Node.js archive
  lib/kici-admin.cjs      # Bundled application
  LICENSE, LICENSES.md, THIRD-PARTY-NOTICES, SOURCE, NODE-LICENSE
```

The launcher executes the CJS bundle using the bundled Node binary. A `kici-agent` started from a full package finds npm beside that binary, so its builder role needs no npm on the host.

### Light package

```
kici-admin-{version}-linux-x64-light/
  kici-admin            # Launcher script (shell or .cmd)
  lib/kici-admin.cjs    # Bundled application
  LICENSE, LICENSES.md, THIRD-PARTY-NOTICES, SOURCE
```

The launcher looks for a cached Node.js binary at:

- **Linux/macOS:** `$XDG_CACHE_HOME/kici/node-binaries/v{VERSION}/bin/node` (default: `~/.cache/...`)
- **Windows:** `%LOCALAPPDATA%\kici\node-binaries\v{VERSION}\node.exe`

`{VERSION}` is the Node.js version the package was built with. The release notes of each KiCI version name it, and the launcher prints it when the binary is missing. If the Node binary is not found, the launcher prints the steps below for its version and platform, and exits with status 1.

#### Install Node.js into the cache

Extract the official Node.js archive for the version into the cache directory. The archive carries npm beside the Node binary, which a `kici-agent` needs for its builder role. Do not copy the `node` binary alone.

On Linux or macOS (replace `linux-x64` with your platform, e.g. `darwin-arm64`):

```bash
NODE_VERSION=<node-version>
ARCHIVE=node-v$NODE_VERSION-linux-x64.tar.gz
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/kici/node-binaries/v$NODE_VERSION"

curl -fsSLO "https://nodejs.org/dist/v$NODE_VERSION/$ARCHIVE"
curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | grep " $ARCHIVE\$" | sha256sum -c -
mkdir -p "$CACHE"
tar -xzf "$ARCHIVE" --strip-components=1 -C "$CACHE"
```

On macOS, use `shasum -a 256 -c -` in place of `sha256sum -c -`.

On Windows (PowerShell; replace `win-x64` with `win-arm64` on ARM):

```powershell
$nodeVersion = '<node-version>'
$folder = "node-v$nodeVersion-win-x64"
$cache = Join-Path $env:LOCALAPPDATA "kici\node-binaries\v$nodeVersion"

Invoke-WebRequest "https://nodejs.org/dist/v$nodeVersion/$folder.zip" -OutFile "$folder.zip"
(Get-FileHash "$folder.zip" -Algorithm SHA256).Hash   # compare with SHASUMS256.txt
Expand-Archive "$folder.zip" -DestinationPath $env:TEMP -Force
New-Item -ItemType Directory -Force $cache | Out-Null
Copy-Item -Recurse -Force "$env:TEMP\$folder\*" $cache
```

A service reads the cache of the account it runs as. A Windows service that runs as LocalSystem, the Windows default, reads `C:\Windows\system32\config\systemprofile\AppData\Local\kici\node-binaries\v{VERSION}\`, so install Node.js there as well.

### License files

Every package has these files at its root:

| File                  | Content                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `LICENSE`             | The license of the component. Each component above is AGPL-3.0-only.                                                  |
| `LICENSES.md`         | How each KiCI package is licensed.                                                                                    |
| `THIRD-PARTY-NOTICES` | Each software package with code in this package: its version, the license it declares and its license text.           |
| `SOURCE`              | Where to get the source code of the release: the `kici-dev/kici-public` repository at the release tag.                |
| `NODE-LICENSE`        | Full packages only. The license of the Node.js runtime and of the npm it includes, from the official Node.js archive. |

## Package size

- **Full packages:** ~35-50 MB per archive (Node binary, npm and bundle, compressed)
- **Light packages:** ~2-5 MB per archive (bundle only)

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

## Check a package works

```bash
# Extract and run (full package)
tar xzf kici-admin-{version}-linux-x64.tar.gz
./kici-admin-{version}-linux-x64/kici-admin --help

# Light package (requires Node cached)
tar xzf kici-admin-{version}-linux-x64-light.tar.gz
./kici-admin-{version}-linux-x64-light/kici-admin --help
```
