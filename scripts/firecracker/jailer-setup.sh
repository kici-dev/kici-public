#!/bin/bash
# scripts/firecracker/jailer-setup.sh
#
# Prepares the jailer directory structure and permissions for Firecracker.
# The jailer provides security isolation (chroot, cgroups, seccomp, uid/gid)
# for Firecracker microVM processes.
#
# Usage:
#   ./jailer-setup.sh --uid <uid> --gid <gid> [OPTIONS]
#
# Required:
#   --uid UID               User ID for the jailer process
#   --gid GID               Group ID for the jailer process
#
# Options:
#   --base-dir DIR          Jailer base directory (default: /srv/jailer)
#   --help                  Show this help message
#
# Exit codes:
#   0  Success
#   1  Error
#
# Must be run as root or with sudo.
#
# References:
#   https://github.com/firecracker-microvm/firecracker/blob/main/docs/jailer.md
#   https://github.com/firecracker-microvm/firecracker/blob/main/docs/prod-host-setup.md

set -euo pipefail

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

# ── Defaults ────────────────────────────────────────────────────────────────

BASE_DIR="/srv/jailer"
UID_ARG=""
GID_ARG=""
ARCH=$(uname -m)

# ── Argument parsing ───────────────────────────────────────────────────────

show_help() {
  echo "KiCI Firecracker Jailer Setup"
  echo ""
  echo "Prepares the jailer directory structure and permissions for Firecracker."
  echo "The jailer provides security isolation (chroot, cgroups, seccomp, uid/gid)"
  echo "for Firecracker microVM processes."
  echo ""
  echo "Usage: $(basename "$0") --uid <uid> --gid <gid> [OPTIONS]"
  echo ""
  echo "Required:"
  echo "  --uid UID               User ID for the jailer (must be non-root, > 0)"
  echo "  --gid GID               Group ID for the jailer (must be non-root, > 0)"
  echo ""
  echo "Options:"
  echo "  --base-dir DIR          Jailer base directory (default: /srv/jailer)"
  echo "  --help                  Show this help message"
  echo ""
  echo "Examples:"
  echo "  sudo $(basename "$0") --uid 1000 --gid 1000"
  echo "  sudo $(basename "$0") --uid 1000 --gid 1000 --base-dir /opt/kici/jailer"
  echo ""
  echo "Architecture: ${ARCH}"
  echo ""
  echo "The jailer directory structure:"
  echo "  <base-dir>/firecracker/<vm-id>/root/"
  echo "    firecracker           # Binary (copied by jailer)"
  echo "    kernel                # Kernel image (copied by orchestrator)"
  echo "    rootfs.ext4           # Rootfs image (copied by orchestrator)"
  echo "    config.json           # VM config (written by orchestrator)"
  echo "    run/"
  echo "      firecracker.socket  # API socket (created by Firecracker)"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --uid)
      UID_ARG="$2"
      shift 2
      ;;
    --gid)
      GID_ARG="$2"
      shift 2
      ;;
    --base-dir)
      BASE_DIR="$2"
      shift 2
      ;;
    --help|-h)
      show_help
      ;;
    *)
      echo "Unknown option: $1"
      echo "Run '$(basename "$0") --help' for usage information."
      exit 1
      ;;
  esac
done

# ── Validation ──────────────────────────────────────────────────────────────

if [ -z "${UID_ARG}" ]; then
  err "Missing required argument: --uid <uid>"
  echo "  Run '$(basename "$0") --help' for usage information."
  exit 1
fi

if [ -z "${GID_ARG}" ]; then
  err "Missing required argument: --gid <gid>"
  echo "  Run '$(basename "$0") --help' for usage information."
  exit 1
fi

# Root check
if [ "$(id -u)" -ne 0 ]; then
  err "This script must be run as root (or via sudo)"
  echo "  Try: sudo $(basename "$0") $*"
  exit 1
fi

# ── Setup ──────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}KiCI Firecracker Jailer Setup${NC}"
echo -e "${BOLD}=============================${NC}"
echo ""
info "Base directory:  ${BASE_DIR}"
info "UID:             ${UID_ARG}"
info "GID:             ${GID_ARG}"
info "Architecture:    ${ARCH}"
echo ""

# ── Step 1: Create base directory ──────────────────────────────────────────

echo -e "${BOLD}Step 1: Directory Structure${NC}"

mkdir -p "${BASE_DIR}/firecracker"
ok "Created ${BASE_DIR}/firecracker/"

# Set ownership
chown "${UID_ARG}:${GID_ARG}" "${BASE_DIR}/firecracker"
ok "Set ownership to ${UID_ARG}:${GID_ARG}"

# Set permissions (rwx for owner, rx for group)
chmod 750 "${BASE_DIR}/firecracker"
ok "Set permissions to 750"

echo ""

# ── Step 2: Verify device nodes ──────────────────────────────────────────

echo -e "${BOLD}Step 2: Device Nodes${NC}"

if [ -c /dev/kvm ]; then
  ok "/dev/kvm exists"
else
  warn "/dev/kvm not found -- required for KVM-based VMs"
  warn "  Load module: sudo modprobe kvm_intel (or kvm_amd)"
fi

if [ -c /dev/net/tun ]; then
  ok "/dev/net/tun exists"
else
  warn "/dev/net/tun not found -- required for TAP networking"
  warn "  Load module: sudo modprobe tun"
fi

echo ""

# ── Step 3: Cgroups setup ─────────────────────────────────────────────────

echo -e "${BOLD}Step 3: Cgroups${NC}"

# Detect cgroups version
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  info "cgroups v2 detected"

  CGROUP_DIR="/sys/fs/cgroup/firecracker"

  if [ -d "${CGROUP_DIR}" ]; then
    info "Cgroup directory already exists: ${CGROUP_DIR}"
  else
    mkdir -p "${CGROUP_DIR}"
    ok "Created cgroup directory: ${CGROUP_DIR}"
  fi

  # Enable controllers for the firecracker cgroup
  # The jailer needs cpu, cpuset, and memory controllers
  if [ -f /sys/fs/cgroup/cgroup.subtree_control ]; then
    AVAILABLE=$(cat /sys/fs/cgroup/cgroup.subtree_control)
    info "Available controllers: ${AVAILABLE}"

    # Try to enable needed controllers at root level
    for controller in cpu cpuset memory; do
      if echo "+${controller}" > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null; then
        ok "Enabled ${controller} controller"
      else
        warn "Could not enable ${controller} controller (may already be enabled or not available)"
      fi
    done
  fi

  # Set permissions on the firecracker cgroup directory
  chown "${UID_ARG}:${GID_ARG}" "${CGROUP_DIR}"
  chmod 755 "${CGROUP_DIR}"
  ok "Set cgroup permissions for uid ${UID_ARG}"

elif [ -d /sys/fs/cgroup/cpu ]; then
  info "cgroups v1 detected"

  # Create cgroup directories for each controller
  for controller in cpu cpuset memory; do
    CGROUP_DIR="/sys/fs/cgroup/${controller}/firecracker"
    if [ ! -d "${CGROUP_DIR}" ]; then
      mkdir -p "${CGROUP_DIR}"
      chown "${UID_ARG}:${GID_ARG}" "${CGROUP_DIR}"
      ok "Created cgroup: ${CGROUP_DIR}"
    else
      info "Cgroup already exists: ${CGROUP_DIR}"
    fi
  done
else
  warn "Could not detect cgroup version"
  warn "  Jailer may not be able to apply resource limits"
fi

echo ""

# ── Summary ────────────────────────────────────────────────────────────────

echo -e "${BOLD}Directory Structure${NC}"
echo ""
echo "  ${BASE_DIR}/"
echo "  └── firecracker/              (owned by ${UID_ARG}:${GID_ARG})"
echo "      └── <vm-id>/              (created per VM by jailer)"
echo "          └── root/"
echo "              ├── firecracker   (binary, copied by jailer)"
echo "              ├── kernel        (copied by orchestrator)"
echo "              ├── rootfs.ext4   (copied by orchestrator)"
echo "              ├── config.json   (written by orchestrator)"
echo "              └── run/"
echo "                  └── firecracker.socket"
echo ""

echo -e "${BOLD}Recommended Limits${NC}"
echo ""
info "Add to /etc/security/limits.conf (for user ${UID_ARG}):"
echo ""
echo "  # KiCI Firecracker jailer limits"

# Get username for the UID if it exists
USERNAME=$(getent passwd "${UID_ARG}" 2>/dev/null | cut -d: -f1 || echo "uid_${UID_ARG}")
echo "  ${USERNAME}  soft  nofile  65536"
echo "  ${USERNAME}  hard  nofile  65536"
echo "  ${USERNAME}  soft  nproc   4096"
echo "  ${USERNAME}  hard  nproc   4096"
echo ""

echo -e "${BOLD}Summary${NC}"
echo ""
ok "Jailer setup complete"
info "Base directory: ${BASE_DIR}"
info "Jailer UID/GID: ${UID_ARG}/${GID_ARG}"
echo ""
if [ "${ARCH}" = "aarch64" ]; then
  warn "arm64: Ensure you have arm64 Firecracker and jailer binaries"
  warn "arm64: Use PE kernel format (Image), not vmlinux"
fi
info "Next steps:"
info "  1. Install the binaries: sudo bash scripts/firecracker/install-firecracker.sh"
info "  2. Build the agent rootfs: sudo env PATH=\"\$PATH\" bash scripts/firecracker/build-agent-rootfs.sh /opt/kici/agent-rootfs.ext4"
info "  3. Provision networking (or let the orchestrator do it at startup):"
info "     sudo kici-admin firecracker provision --bridge kici-br0 --cidr 10.0.0.1/24"
info "  4. Verify the setup: bash scripts/firecracker/validate.sh --bridge-name kici-br0"
