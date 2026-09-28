#!/usr/bin/env bash
# scripts/firecracker/build-agent-rootfs.sh
#
# Builds a Debian 13 (trixie) minimal rootfs with Node.js and the KiCI agent
# bundle baked in, suitable for Firecracker microVM execution.
#
# Two-phase build:
#   Phase 1 (base) — debootstrap, packages, Node.js, pnpm, oxc-transform, dockerode
#     shim. Cached at BASE_CACHE_PATH; only rebuilt when missing, when the host
#     Node.js version or this script changes, or when --force-base is passed.
#   Phase 2 (inject) — Rolldown-bundle agent + workflow-runner, copy them and the
#     VM /init (agent-init.sh, beside this script) into the rootfs. Fast
#     (~seconds), runs on every invocation.
#
# Run it from a clone of the KiCI source repository, checked out at the release
# of the orchestrator that boots the image, after installing and building the
# workspace:
#   pnpm install --frozen-lockfile
#   pnpm build
#
# Usage:
#   sudo env PATH="$PATH" bash scripts/firecracker/build-agent-rootfs.sh [FLAGS] [OUTPUT] [SIZE_MB]
#
# Flags:
#   --agent-only        Skip base check, just re-inject agent bundles into OUTPUT
#   --force-base        Force rebuild of the base image
#   --check-workspace   Check that the workspace is installed and built, then exit
#                       (needs no root)
#
# Arguments:
#   OUTPUT          Output path for ext4 image (default: /var/lib/kici/agent-rootfs.ext4)
#   SIZE_MB         Image size in MB (default: 1024)
#
# Environment:
#   BASE_CACHE_PATH     Base image cache path (default: /var/lib/kici/rootfs-base.ext4).
#                       Its stamp files sit beside it, named after it.
#   KICI_NPM_REGISTRY   npm registry for the base image's installs (default: npmjs)
#
# Must be run as root or with sudo.

set -euo pipefail

# Invocations via `sudo env PATH=$PATH` inherit the calling user's PATH, which
# may lack /usr/sbin — and losetup lives there. The stale-mount sweep must
# never silently no-op because a tool is unresolvable, so own the PATH up front.
export PATH="$PATH:/usr/sbin:/sbin"

# ── Color output ────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

info() { echo -e "  ${BLUE}INFO${NC}  $1"; }
ok() { echo -e "  ${GREEN}OK${NC}    $1"; }
warn() { echo -e "  ${YELLOW}WARN${NC}  $1"; }
err() { echo -e "  ${RED}ERR${NC}   $1"; }

# ── Flag parsing ──────────────────────────────────────────────────────────

AGENT_ONLY=false
FORCE_BASE=false
CHECK_WORKSPACE=false
POSITIONAL=()
# The command line as given, for the re-run hints below: the loop consumes "$@".
INVOCATION="bash $0 $*"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent-only) AGENT_ONLY=true; shift ;;
    --force-base) FORCE_BASE=true; shift ;;
    --check-workspace) CHECK_WORKSPACE=true; shift ;;
    *) POSITIONAL+=("$1"); shift ;;
  esac
done

OUTPUT="${POSITIONAL[0]:-/var/lib/kici/agent-rootfs.ext4}"
SIZE_MB="${POSITIONAL[1]:-1024}"

# ── Constants ──────────────────────────────────────────────────────────────

BASE_CACHE_PATH="${BASE_CACHE_PATH:-/var/lib/kici/rootfs-base.ext4}"
# The stamps belong to the base image they describe, so a second base cache
# on the same host never reads or overwrites the stamps of the first.
NODE_VERSION_STAMP="${BASE_CACHE_PATH%.ext4}.node-version"
SCRIPT_HASH_STAMP="${BASE_CACHE_PATH%.ext4}.script-hash"

ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  NODE_ARCH="x64" ;;
  aarch64) NODE_ARCH="arm64" ;;
  *)
    err "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ── Workspace check ─────────────────────────────────────────────────────────
# The agent is bundled from this checkout's sources and dependencies, and the
# base image takes its TypeScript loader hook from the built @kici-dev/core and
# the transform binding's version from the installed workspace. Check them
# before any root step, so an unbuilt clone fails here rather than minutes into
# a base build.

OXC_STORE=("$REPO_ROOT"/node_modules/.pnpm/oxc-transform@*)
if [ ! -f "$REPO_ROOT/packages/core/dist/ts-loader-hook.js" ] || [ ! -e "${OXC_STORE[0]}" ]; then
  err "The workspace in $REPO_ROOT is not installed and built"
  echo "  Run in $REPO_ROOT: pnpm install --frozen-lockfile && pnpm build"
  exit 1
fi
if [ "$CHECK_WORKSPACE" = true ]; then
  ok "The workspace in $REPO_ROOT is installed and built"
  exit 0
fi

# ── Root check ──────────────────────────────────────────────────────────────

if [ "$(id -u)" -ne 0 ]; then
  err "This script requires root for mount operations (or via sudo)"
  echo "  Try: sudo env PATH=\"\$PATH\" $INVOCATION"
  exit 1
fi

# ── Host node discovery ────────────────────────────────────────────────────
# `sudo` strips PATH on hosts where the build user manages node outside
# /usr/bin, for example a host whose Node.js is the one the KiCI standalone
# packages download into ~/.cache/kici/node-binaries. Fall back to common
# locations + the invoking user's kici node-binaries dir before giving up.
# Only v<ver>/bin/node is this host's runtime: the packaging cache beside it
# (v<ver>/<os>-<arch>/bin/node) holds other platforms' binaries. Used by every
# `node ...` invocation on the host below; rootfs-internal node uses
# /usr/local/bin/node via chroot, unrelated.

HOST_NODE="$(command -v node 2>/dev/null || true)"
if [ -z "$HOST_NODE" ]; then
  for cand in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do
    [ -x "$cand" ] && HOST_NODE="$cand" && break
  done
fi
if [ -z "$HOST_NODE" ] && [ -n "${SUDO_USER:-}" ]; then
  cand=$(find /home/"$SUDO_USER"/.cache/kici/node-binaries -mindepth 3 -maxdepth 3 -path '*/bin/node' 2>/dev/null | sort -V | tail -1)
  [ -x "$cand" ] && HOST_NODE="$cand"
fi
if [ -z "$HOST_NODE" ]; then
  err "Host 'node' not found in PATH and no fallback (/usr/local/bin/node, ~/.cache/kici/node-binaries/v*/bin/node) succeeded"
  echo "  Re-run via: sudo env PATH=\"\$PATH\" $INVOCATION"
  exit 1
fi

# ── Prerequisites ──────────────────────────────────────────────────────────

if [ "$AGENT_ONLY" = false ]; then
  for tool in debootstrap mkfs.ext4 curl; do
    if ! command -v "${tool}" &>/dev/null; then
      err "Required tool '${tool}' not found"
      exit 1
    fi
  done
fi

# The default image paths sit under /var/lib/kici, which a fresh host lacks.
mkdir -p "$(dirname "$OUTPUT")" "$(dirname "$BASE_CACHE_PATH")"

# ── Cleanup trap ────────────────────────────────────────────────────────────

MOUNT_POINT=$(mktemp -d -t kici-fc-XXXXXX)
BASE_MOUNT=""
NODE_TMP=""
BUNDLE_TMP=""
cleanup() {
  if mountpoint -q "$MOUNT_POINT" 2>/dev/null; then
    umount "$MOUNT_POINT" 2>/dev/null || true
  fi
  rm -rf "$MOUNT_POINT"
  # NODE_TMP / BUNDLE_TMP are also removed at their own use sites; reap them
  # here too so a mid-build failure between mktemp and that rm never leaks a
  # kici-fc- tempdir.
  if [ -n "${NODE_TMP:-}" ]; then rm -rf "$NODE_TMP"; fi
  if [ -n "${BUNDLE_TMP:-}" ]; then rm -rf "$BUNDLE_TMP"; fi
}
# An untrapped fatal signal skips the EXIT trap (leaking the mount); trap the
# fatal signals and exit so cleanup runs exactly once. build_base() later
# re-points the EXIT trap to 'base_cleanup; cleanup' — the signal traps below
# still funnel through whatever EXIT trap is current.
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# ── Inject serialization + stale-mount sweep ────────────────────────────────
# A per-rootfs flock serializes the mount→inject→umount critical section so a
# retried/concurrent build blocks (up to 120s) instead of stacking loop-mounts
# of the same ext4 image — concurrent rw mounts of one image risk filesystem
# corruption. The kernel releases the lock fd on process death, so an aborted
# run never wedges the lock. Lock key = hash of the OUTPUT path, so any tool
# that injects into the same image file under the same lock serializes against
# this one.

acquire_inject_lock() {
  local image="$1" lock
  lock="/tmp/kici-fc-inject-$(printf %s "$image" | md5sum | cut -d' ' -f1).lock"
  exec 9>"$lock"
  if ! flock -w 120 9; then
    err "Could not acquire inject lock $lock after 120s — a previous build/inject is still running or hung"
    exit 1
  fi
}

# With the lock held, any loop device still backed by $1 was leaked by an
# aborted run — unmount it before mounting fresh. Hard error if the unmount
# fails: an image we cannot unmount must not be mounted a second time.
sweep_stale_mounts() {
  local image="$1" loopdev tgt
  while read -r loopdev _; do
    loopdev="${loopdev%:}"
    [ -n "$loopdev" ] || continue
    while read -r tgt; do
      [ -n "$tgt" ] || continue
      warn "Sweeping stale mount of $image at $tgt (leaked by an aborted run)"
      if ! umount "$tgt"; then
        err "Failed to unmount stale mount at $tgt — refusing to mount $image a second time"
        exit 1
      fi
      rmdir "$tgt" 2>/dev/null || true
    done < <(findmnt -rn -o TARGET -S "$loopdev" || true)
  done < <(losetup -j "$image" 2>/dev/null || true)
}

acquire_inject_lock "$OUTPUT"

echo ""
echo -e "${BOLD}KiCI Firecracker Agent Rootfs Builder${NC}"
echo -e "${BOLD}======================================${NC}"
echo ""

# ── stage_core_loader_hook() ────────────────────────────────────────────────
# Copy @kici-dev/core/ts-loader-hook.js plus every local `.js` chunk it
# transitively imports into the given dist dir. Rolldown emits ts-loader-hook's
# shared runtime as rolldown-runtime-<hash>.js (not chunk-*.js), so following the
# actual `./`-relative import specifiers is rename-proof where a hardcoded glob
# is not. Kept in sync with installRuntimeCompanions() in scripts/package.mjs,
# which stages the same hook for the standalone agent package.
stage_core_loader_hook() {
  local dest="$1"
  local src="$REPO_ROOT/packages/core/dist"
  local -a seen=()
  local -a queue=("ts-loader-hook.js")
  local f dep
  while [ "${#queue[@]}" -gt 0 ]; do
    f="${queue[0]}"
    queue=("${queue[@]:1}")
    case " ${seen[*]} " in *" $f "*) continue ;; esac
    seen+=("$f")
    cp "$src/$f" "$dest/"
    while IFS= read -r dep; do
      [ -z "$dep" ] && continue
      case " ${seen[*]} " in *" $dep "*) ;; *) queue+=("$dep") ;; esac
    done < <(grep -oE "['\"]\\./[^'\"]+\\.js['\"]" "$src/$f" | sed -E "s/^['\"]\\.\\///; s/['\"]\$//")
  done
}

# ── build_base() ────────────────────────────────────────────────────────────
# Creates the base rootfs image with OS, Node.js, pnpm, oxc-transform, shims.

build_base() {
  # Global (not local) — the EXIT trap references BASE_MOUNT after build_base() returns,
  # when local vars are out of scope. With set -u, a local var causes "unbound variable".
  BASE_MOUNT=$(mktemp -d -t kici-fc-XXXXXX)

  # Same pattern for base_cleanup_done.
  base_cleanup_done=false
  base_cleanup() {
    if [ "$base_cleanup_done" = true ]; then return; fi
    base_cleanup_done=true
    if mountpoint -q "$BASE_MOUNT" 2>/dev/null; then
      umount "$BASE_MOUNT" 2>/dev/null || true
    fi
    rm -rf "$BASE_MOUNT"
  }
  trap 'base_cleanup; cleanup' EXIT

  info "Building base image at ${BASE_CACHE_PATH}"
  info "Image size: ${SIZE_MB} MB"
  echo ""

  # Step 1: Create ext4 image
  echo -e "${BOLD}Step 1: Create ext4 image${NC}"
  dd if=/dev/zero of="$BASE_CACHE_PATH" bs=1M count=0 seek="$SIZE_MB" status=none
  mkfs.ext4 -q -F "$BASE_CACHE_PATH"
  sweep_stale_mounts "$BASE_CACHE_PATH"
  mount "$BASE_CACHE_PATH" "$BASE_MOUNT"
  ok "Created and mounted ${SIZE_MB}MB ext4 image"
  echo ""

  # Step 2: Bootstrap Debian 13 (trixie)
  echo -e "${BOLD}Step 2: Debootstrap Debian 13 (trixie)${NC}"
  debootstrap --variant=minbase trixie "$BASE_MOUNT" http://deb.debian.org/debian
  ok "Bootstrapped Debian 13 minimal base"
  echo ""

  # Step 3: Strip unnecessary files
  echo -e "${BOLD}Step 3: Strip unnecessary files${NC}"
  rm -rf "$BASE_MOUNT"/usr/share/man
  rm -rf "$BASE_MOUNT"/usr/share/doc
  rm -rf "$BASE_MOUNT"/usr/share/locale
  rm -rf "$BASE_MOUNT"/var/cache/apt/archives/*
  rm -rf "$BASE_MOUNT"/var/lib/apt/lists/*
  ok "Stripped man pages, docs, locales"
  echo ""

  # Step 4: Install minimal packages
  echo -e "${BOLD}Step 4: Install minimal packages${NC}"
  chroot "$BASE_MOUNT" apt-get update -qq
  chroot "$BASE_MOUNT" apt-get install -y --no-install-recommends curl ca-certificates git
  chroot "$BASE_MOUNT" apt-get clean
  rm -rf "$BASE_MOUNT"/var/cache/apt/archives/* "$BASE_MOUNT"/var/lib/apt/lists/*
  ok "Installed curl, ca-certificates, git"
  echo ""

  # Step 5: Install Node.js
  echo -e "${BOLD}Step 5: Install Node.js${NC}"
  HOST_NODE_VERSION=$("$HOST_NODE" --version 2>/dev/null | sed 's/^v//' || echo "")

  if [ -n "$HOST_NODE_VERSION" ]; then
    NODE_URL="https://nodejs.org/dist/v${HOST_NODE_VERSION}/node-v${HOST_NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
    info "Using host Node.js version: v${HOST_NODE_VERSION}"
  else
    NODE_URL="https://nodejs.org/dist/v24.0.0/node-v24.0.0-linux-${NODE_ARCH}.tar.xz"
    info "Using Node.js v24.0.0"
  fi

  NODE_TMP=$(mktemp -d -t kici-fc-XXXXXX)
  curl -fSL "$NODE_URL" -o "$NODE_TMP/node.tar.xz"
  tar -xJf "$NODE_TMP/node.tar.xz" -C "$NODE_TMP"
  cp "$NODE_TMP"/node-v*/bin/node "$BASE_MOUNT"/usr/local/bin/node
  chmod 755 "$BASE_MOUNT"/usr/local/bin/node

  cp -r "$NODE_TMP"/node-v*/lib/node_modules "$BASE_MOUNT"/usr/local/lib/node_modules
  ln -sf ../lib/node_modules/npm/bin/npm-cli.js "$BASE_MOUNT"/usr/local/bin/npm
  ln -sf ../lib/node_modules/npm/bin/npx-cli.js "$BASE_MOUNT"/usr/local/bin/npx
  rm -rf "$NODE_TMP"

  # Strip npm bloat
  rm -rf "$BASE_MOUNT"/usr/local/lib/node_modules/npm/docs
  rm -rf "$BASE_MOUNT"/usr/local/lib/node_modules/npm/man
  rm -rf "$BASE_MOUNT"/usr/local/lib/node_modules/npm/changelogs
  rm -rf "$BASE_MOUNT"/usr/local/include
  ok "Installed Node.js + npm/npx to /usr/local/bin/"

  # Optional: route the base-image npm installs (pnpm + oxc-transform below)
  # through a registry mirror or pull-through cache. When KICI_NPM_REGISTRY is
  # set (e.g. http://127.0.0.1:4873/), it is exported into the chroot as
  # npm_config_registry so both installs are served from the mirror instead of
  # re-downloaded from npmjs. The chroot shares the host network namespace, so
  # a loopback URL reaches a mirror listening on the host without any name
  # resolution inside the fresh rootfs.
  # Unset (the default, and the cached-base path) leaves the installs on npmjs,
  # unchanged. `env` runs on the host and chroot inherits the exported var.
  NPM_REGISTRY_ENV=()
  if [ -n "${KICI_NPM_REGISTRY:-}" ]; then
    NPM_REGISTRY_ENV=("npm_config_registry=${KICI_NPM_REGISTRY}")
    info "Routing base-image npm installs through ${KICI_NPM_REGISTRY}"
  fi

  # Install pnpm
  info "Installing pnpm..."
  env "${NPM_REGISTRY_ENV[@]}" chroot "$BASE_MOUNT" /usr/local/bin/node /usr/local/bin/npm install -g pnpm --no-audit --no-fund 2>&1 | tail -3
  ok "Installed pnpm to /usr/local/bin/"
  echo ""

  # Install oxc-transform (native NAPI bindings, cannot be bundled). It's the
  # engine behind `@kici-dev/core/ts-loader-hook`, which the workflow-runner
  # registers at startup to transform `.kici/workflows/*.ts` on import.
  # oxc-transform lives under pnpm's virtual store since it's not a
  # monorepo-root dep — it's pulled in as a direct dep of @kici-dev/core.
  # Read the version from the pnpm virtual store to pin the install.
  OXC_TRANSFORM_VERSION=$("$HOST_NODE" -e "const fs=require('fs'),path=require('path');const globSync=fs.globSync||((p)=>{throw new Error('Node 22+ required')});const matches=globSync('$REPO_ROOT/node_modules/.pnpm/oxc-transform@*');if(!matches.length)throw new Error('oxc-transform not found in pnpm store');const pkg=JSON.parse(fs.readFileSync(path.join(matches[0],'node_modules/oxc-transform/package.json'),'utf8'));console.log(pkg.version);")
  echo -e "${BOLD}Step 6: Install oxc-transform + shims${NC}"
  info "Installing oxc-transform@${OXC_TRANSFORM_VERSION} into rootfs..."
  env "${NPM_REGISTRY_ENV[@]}" chroot "$BASE_MOUNT" /usr/local/bin/node /usr/local/bin/npm install \
    --prefix /opt/kici \
    "oxc-transform@${OXC_TRANSFORM_VERSION}" \
    --save=false --no-audit --no-fund 2>&1 | tail -5
  ok "Installed oxc-transform@${OXC_TRANSFORM_VERSION} in /opt/kici/node_modules/"

  # Copy `@kici-dev/core/ts-loader-hook` into the rootfs. The workflow-runner
  # bundle externalizes `@kici-dev/core/ts-loader-hook` and resolves it at
  # runtime via `module.register()` — so the subpath export must be reachable
  # from /opt/kici. Only the loader-hook dist is needed; everything else in
  # @kici-dev/core is either bundled into the agent output or Firecracker-
  # inapplicable.
  info "Copying @kici-dev/core/ts-loader-hook (+ its local dist chunks) into rootfs..."
  mkdir -p "$BASE_MOUNT"/opt/kici/node_modules/@kici-dev/core/dist
  stage_core_loader_hook "$BASE_MOUNT/opt/kici/node_modules/@kici-dev/core/dist"
  cat > "$BASE_MOUNT"/opt/kici/node_modules/@kici-dev/core/package.json << 'CORE_PKG'
{
  "name": "@kici-dev/core",
  "version": "0.0.0-firecracker-stub",
  "type": "module",
  "exports": {
    "./ts-loader-hook": {
      "import": "./dist/ts-loader-hook.js"
    }
  }
}
CORE_PKG
  ok "Installed @kici-dev/core/ts-loader-hook stub in /opt/kici/node_modules/"

  # Dockerode ESM shim (agent imports it but Firecracker VMs never use Docker)
  mkdir -p "$BASE_MOUNT"/opt/kici/node_modules/dockerode
  cat > "$BASE_MOUNT"/opt/kici/node_modules/dockerode/package.json << 'SHIM_PKG'
{ "name": "dockerode", "version": "0.0.0-shim", "type": "module", "main": "index.js" }
SHIM_PKG
  cat > "$BASE_MOUNT"/opt/kici/node_modules/dockerode/index.js << 'SHIM_JS'
class Docker { constructor() { throw new Error('Docker is not available inside Firecracker VMs'); } }
export default Docker;
SHIM_JS
  ok "Created dockerode ESM shim"
  echo ""

  # DNS
  echo -e "${BOLD}Step 7: Configure DNS${NC}"
  echo "nameserver 8.8.8.8" > "$BASE_MOUNT"/etc/resolv.conf
  echo "nameserver 1.1.1.1" >> "$BASE_MOUNT"/etc/resolv.conf
  ok "Wrote /etc/resolv.conf"
  echo ""

  # Create agent directories (inject_agent will populate them)
  mkdir -p "$BASE_MOUNT"/opt/kici/sandbox

  # Finalize base
  sync
  umount "$BASE_MOUNT"
  rm -rf "$BASE_MOUNT"
  base_cleanup_done=true

  # Write Node.js version stamp
  if [ -n "$HOST_NODE_VERSION" ]; then
    echo "$HOST_NODE_VERSION" > "$NODE_VERSION_STAMP"
  fi

  # Write script hash stamp so we detect when the build script itself changes
  sha256sum "$0" | cut -d' ' -f1 > "$SCRIPT_HASH_STAMP"

  ok "Base image built: ${BASE_CACHE_PATH} ($(du -h "$BASE_CACHE_PATH" | cut -f1))"
  echo ""
}

# ── inject_agent() ──────────────────────────────────────────────────────────
# Bundles agent + workflow-runner with Rolldown and copies them, and the VM
# /init, into the rootfs.

inject_agent() {
  local TARGET="$1"

  info "Injecting agent into ${TARGET}"

  # Bundle with Rolldown
  BUNDLE_TMP=$(mktemp -d -t kici-fc-XXXXXX)
  info "Bundling agent with Rolldown..."
  "$HOST_NODE" "$SCRIPT_DIR/bundle-agent.mjs" "$BUNDLE_TMP"
  ok "Agent bundled ($(du -h "$BUNDLE_TMP/agent.js" | cut -f1))"
  ok "Workflow runner bundled ($(du -h "$BUNDLE_TMP/sandbox/workflow-runner.js" | cut -f1))"
  ok "Eval runner bundled ($(du -h "$BUNDLE_TMP/eval-runner.js" | cut -f1))"

  # Mount output image and copy bundles
  sweep_stale_mounts "$TARGET"
  mount "$TARGET" "$MOUNT_POINT"
  mkdir -p "$MOUNT_POINT"/opt/kici/sandbox
  cp "$BUNDLE_TMP/agent.js" "$MOUNT_POINT"/opt/kici/agent.js
  cp "$BUNDLE_TMP/sandbox/workflow-runner.js" "$MOUNT_POINT"/opt/kici/sandbox/workflow-runner.js
  # Sibling of agent.js: `resolveEvalRunnerPath()` probes the agent entry's own
  # directory first, and every evaluation job (`__init__`, `__dynamic__`,
  # `__build__`, a global eval round) forks it.
  cp "$BUNDLE_TMP/eval-runner.js" "$MOUNT_POINT"/opt/kici/eval-runner.js
  rm -rf "$BUNDLE_TMP"

  # Refresh the externalized `@kici-dev/core/ts-loader-hook` subpath (dist +
  # chunk siblings + package.json stub) on every inject. The workflow-runner
  # bundle externalizes that import and resolves it at runtime via
  # `module.register()`, so the stub is a property of the CURRENT bundle, not
  # of the base rootfs. The base is cached and only rebuilt when the script
  # hash or Node version changes — so when a release changes the externalized
  # dependency set, a base built before it lacks that package, and injecting
  # only the JS bundles strands the VM with a workflow-runner that imports a
  # package the rootfs doesn't contain ("Cannot find package '@kici-dev/core'").
  # Mirroring Step 6 of build_base() here keeps --agent-only self-sufficient
  # regardless of base age.
  info "Refreshing @kici-dev/core/ts-loader-hook (+ its local dist chunks) in rootfs..."
  mkdir -p "$MOUNT_POINT"/opt/kici/node_modules/@kici-dev/core/dist
  stage_core_loader_hook "$MOUNT_POINT/opt/kici/node_modules/@kici-dev/core/dist"
  cat > "$MOUNT_POINT"/opt/kici/node_modules/@kici-dev/core/package.json << 'CORE_PKG'
{
  "name": "@kici-dev/core",
  "version": "0.0.0-firecracker-stub",
  "type": "module",
  "exports": {
    "./ts-loader-hook": {
      "import": "./dist/ts-loader-hook.js"
    }
  }
}
CORE_PKG
  ok "Refreshed @kici-dev/core/ts-loader-hook stub"

  # The VM /init reads the MMDS keys the orchestrator writes, so it moves with
  # the agent, not with the cached base: an --agent-only refresh of an old image
  # gets the /init that matches the orchestrator it runs under.
  install -m 755 "$SCRIPT_DIR/agent-init.sh" "$MOUNT_POINT"/init
  ok "Installed /init"

  sync
  umount "$MOUNT_POINT"
  ok "Agent injected into ${TARGET}"
  echo ""
}

# ── Main flow ──────────────────────────────────────────────────────────────

OUTPUT_BASE_HASH_STAMP="${OUTPUT}.base-hash"

if [ "$AGENT_ONLY" = true ]; then
  # Fast path: just re-inject agent bundles into existing output image,
  # but first check that the output was built from the CURRENT base. If the
  # base script changed since this output was produced, re-copy the base
  # before injecting -- otherwise a stale shim or stale Node binaries persist.
  if [ ! -f "$OUTPUT" ]; then
    err "Output image not found: ${OUTPUT} (run without --agent-only first)"
    exit 1
  fi
  if [ ! -f "$BASE_CACHE_PATH" ] || [ ! -f "$SCRIPT_HASH_STAMP" ]; then
    err "Base cache missing (${BASE_CACHE_PATH} / ${SCRIPT_HASH_STAMP}); cannot use --agent-only"
    exit 1
  fi
  CURRENT_BASE_HASH=$(cat "$SCRIPT_HASH_STAMP")
  OUTPUT_BASE_HASH=""
  if [ -f "$OUTPUT_BASE_HASH_STAMP" ]; then
    OUTPUT_BASE_HASH=$(cat "$OUTPUT_BASE_HASH_STAMP")
  fi
  if [ "$CURRENT_BASE_HASH" != "$OUTPUT_BASE_HASH" ]; then
    info "Output base stamp stale (${OUTPUT_BASE_HASH:-missing} -> ${CURRENT_BASE_HASH}), re-copying base before agent inject"
    cp "$BASE_CACHE_PATH" "$OUTPUT"
    echo "$CURRENT_BASE_HASH" > "$OUTPUT_BASE_HASH_STAMP"
  else
    info "Agent-only mode: re-injecting agent bundles (base stamp matches)"
  fi
  inject_agent "$OUTPUT"
  ok "Done (agent-only)"
  echo ""
  exit 0
fi

# Check if base needs rebuilding
NEED_BASE=false
if [ "$FORCE_BASE" = true ]; then
  info "Forcing base rebuild (--force-base)"
  NEED_BASE=true
elif [ ! -f "$BASE_CACHE_PATH" ]; then
  info "Base image not found, building..."
  NEED_BASE=true
else
  # Check Node.js version stamp
  HOST_NODE_VERSION=$("$HOST_NODE" --version 2>/dev/null | sed 's/^v//' || echo "")
  if [ -f "$NODE_VERSION_STAMP" ]; then
    CACHED_VERSION=$(cat "$NODE_VERSION_STAMP")
    if [ "$HOST_NODE_VERSION" != "$CACHED_VERSION" ]; then
      info "Node.js version changed (${CACHED_VERSION} -> ${HOST_NODE_VERSION}), rebuilding base"
      NEED_BASE=true
    else
      ok "Base image up-to-date (Node.js v${CACHED_VERSION})"
    fi
  else
    info "No version stamp found, rebuilding base"
    NEED_BASE=true
  fi

  # Check script hash stamp — rebuild if build script itself changed
  if [ "$NEED_BASE" = false ]; then
    CURRENT_HASH=$(sha256sum "$0" | cut -d' ' -f1)
    if [ -f "$SCRIPT_HASH_STAMP" ]; then
      CACHED_HASH=$(cat "$SCRIPT_HASH_STAMP")
      if [ "$CURRENT_HASH" != "$CACHED_HASH" ]; then
        info "Build script changed, rebuilding base"
        NEED_BASE=true
      fi
    else
      info "No script hash stamp found, rebuilding base"
      NEED_BASE=true
    fi
  fi
fi

if [ "$NEED_BASE" = true ]; then
  build_base
fi

# Copy base to output
info "Copying base image to ${OUTPUT}..."
cp "$BASE_CACHE_PATH" "$OUTPUT"
cp "$SCRIPT_HASH_STAMP" "$OUTPUT_BASE_HASH_STAMP"
ok "Base copied to ${OUTPUT}"

# Inject agent bundles
inject_agent "$OUTPUT"

ACTUAL_SIZE=$(du -h "$OUTPUT" | cut -f1)
echo -e "${BOLD}Summary${NC}"
echo ""
ok "Agent rootfs built: ${OUTPUT}"
info "Virtual size:    ${SIZE_MB} MB"
info "Actual size:     ${ACTUAL_SIZE}"
info "Architecture:    ${ARCH}"
echo ""
