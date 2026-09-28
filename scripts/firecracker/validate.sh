#!/bin/bash
# scripts/firecracker/validate.sh
#
# Host prerequisite validation script for Firecracker microVM support.
# Checks that the host has all required hardware, binaries, and configuration
# for running Firecracker VMs with KiCI.
#
# Usage:
#   ./validate.sh [OPTIONS]
#
# Options:
#   --firecracker-path PATH   Path to firecracker binary (default: /usr/local/bin/firecracker)
#   --jailer-path PATH        Path to jailer binary (default: /usr/local/bin/jailer)
#   --bridge-name NAME        Bridge interface to check (default: skip bridge check)
#   --help                    Show this help message
#
# Exit codes:
#   0  All checks passed
#   1  One or more checks failed
#
# References:
#   https://github.com/firecracker-microvm/firecracker/blob/main/docs/prod-host-setup.md
#   https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md

set -euo pipefail

# nft (and ip, on some distributions) lives in /usr/sbin, which a regular
# user's PATH often lacks: look there too, or an installed tool reads as missing.
export PATH="$PATH:/usr/sbin:/sbin"

# ── Color output ────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

pass() { echo -e "  ${GREEN}PASS${NC}  $1"; }
fail() { echo -e "  ${RED}FAIL${NC}  $1"; FAILED=1; }
warn() { echo -e "  ${YELLOW}WARN${NC}  $1"; }
info() { echo -e "  ${BLUE}INFO${NC}  $1"; }

# ── Defaults ────────────────────────────────────────────────────────────────

# install-firecracker.sh installs both binaries here.
FIRECRACKER_PATH="/usr/local/bin/firecracker"
JAILER_PATH="/usr/local/bin/jailer"
BRIDGE_NAME=""
FAILED=0

# ── Argument parsing ───────────────────────────────────────────────────────

show_help() {
  echo "KiCI Firecracker Host Validation"
  echo ""
  echo "Checks that the host has all required hardware, binaries, and configuration"
  echo "for running Firecracker microVMs with KiCI."
  echo ""
  echo "Usage: $(basename "$0") [OPTIONS]"
  echo ""
  echo "Options:"
  echo "  --firecracker-path PATH   Path to firecracker binary (default: /usr/local/bin/firecracker)"
  echo "  --jailer-path PATH        Path to jailer binary (default: /usr/local/bin/jailer)"
  echo "  --bridge-name NAME        Bridge interface to check (default: skip bridge check)"
  echo "  --help                    Show this help message"
  echo ""
  echo "Exit codes:"
  echo "  0  All checks passed"
  echo "  1  One or more checks failed"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --firecracker-path)
      FIRECRACKER_PATH="$2"
      shift 2
      ;;
    --jailer-path)
      JAILER_PATH="$2"
      shift 2
      ;;
    --bridge-name)
      BRIDGE_NAME="$2"
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

# ── Architecture detection ──────────────────────────────────────────────────

ARCH=$(uname -m)
KERNEL_VERSION=$(uname -r)

echo ""
echo -e "${BOLD}KiCI Firecracker Host Validation${NC}"
echo -e "${BOLD}================================${NC}"
echo ""
info "Host architecture: ${ARCH}"
info "Kernel version: ${KERNEL_VERSION}"
echo ""

# ── Check 1: /dev/kvm ──────────────────────────────────────────────────────

echo -e "${BOLD}Hardware Virtualization${NC}"

if [ -c /dev/kvm ]; then
  pass "/dev/kvm character device exists"
else
  fail "/dev/kvm not found -- hardware virtualization not available"
  if [ "${ARCH}" = "x86_64" ]; then
    warn "  Ensure Intel VT-x or AMD-V is enabled in BIOS/UEFI"
    warn "  Load kvm module: sudo modprobe kvm_intel (or kvm_amd)"
  elif [ "${ARCH}" = "aarch64" ]; then
    warn "  ARM KVM requires a host kernel with KVM support compiled in"
  fi
fi

# ── Check 2: KVM permissions ──────────────────────────────────────────────

if [ -c /dev/kvm ]; then
  if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
    pass "/dev/kvm is readable and writable by current user ($(whoami))"
  else
    fail "/dev/kvm is not accessible by current user ($(whoami))"
    warn "  Fix: sudo usermod -aG kvm $(whoami) && newgrp kvm"
    warn "  Or: sudo chmod 666 /dev/kvm (less secure)"
  fi
fi

echo ""

# ── Check 3: Firecracker binary ───────────────────────────────────────────

echo -e "${BOLD}Binaries${NC}"

if [ -x "${FIRECRACKER_PATH}" ]; then
  pass "firecracker binary found at ${FIRECRACKER_PATH}"
  FC_VERSION=$("${FIRECRACKER_PATH}" --version 2>&1 | head -1)
  info "Firecracker version: ${FC_VERSION}"
else
  if [ -f "${FIRECRACKER_PATH}" ]; then
    fail "firecracker binary at ${FIRECRACKER_PATH} is not executable"
    warn "  Fix: chmod +x ${FIRECRACKER_PATH}"
  else
    fail "firecracker binary not found at ${FIRECRACKER_PATH}"
    warn "  Install: sudo bash scripts/firecracker/install-firecracker.sh"
  fi
fi

# ── Check 4: Jailer binary ────────────────────────────────────────────────

if [ -x "${JAILER_PATH}" ]; then
  pass "jailer binary found at ${JAILER_PATH}"
else
  if [ -f "${JAILER_PATH}" ]; then
    fail "jailer binary at ${JAILER_PATH} is not executable"
    warn "  Fix: chmod +x ${JAILER_PATH}"
  else
    fail "jailer binary not found at ${JAILER_PATH}"
    warn "  Install: sudo bash scripts/firecracker/install-firecracker.sh"
  fi
fi

echo ""

# ── Check 5: Network tools ────────────────────────────────────────────────

echo -e "${BOLD}Network Tools${NC}"

if command -v ip &>/dev/null; then
  pass "ip (iproute2) is installed"
else
  fail "ip (iproute2) not found -- required for TAP device and bridge management"
  warn "  Install: sudo apt install iproute2 (Debian/Ubuntu)"
  warn "           sudo dnf install iproute (Fedora/RHEL)"
fi

if command -v nft &>/dev/null; then
  pass "nft (nftables) is installed"
elif command -v iptables-nft &>/dev/null; then
  pass "iptables-nft is installed (nftables backend)"
elif command -v iptables &>/dev/null; then
  warn "Only legacy iptables found -- nftables (nft) is recommended"
  warn "  Legacy iptables is deprecated on modern Linux distributions"
  warn "  Install: sudo apt install nftables (Debian/Ubuntu)"
else
  fail "No firewall tool found -- nft or iptables-nft required for NAT"
  warn "  Install: sudo apt install nftables (Debian/Ubuntu)"
  warn "           sudo dnf install nftables (Fedora/RHEL)"
fi

echo ""

# ── Check 6: Bridge interface ─────────────────────────────────────────────

if [ -n "${BRIDGE_NAME}" ]; then
  echo -e "${BOLD}Network Bridge${NC}"

  if ip link show "${BRIDGE_NAME}" &>/dev/null; then
    pass "Bridge interface '${BRIDGE_NAME}' exists"
    # The UP flag is the administrative state. A bridge with no VM attached
    # reports its operational state as DOWN (no carrier) and is still healthy.
    BRIDGE_FLAGS=$(ip -o link show "${BRIDGE_NAME}" | sed -n 's/^[^<]*<\([^>]*\)>.*/\1/p')
    if [[ ",${BRIDGE_FLAGS}," == *",UP,"* ]]; then
      pass "Bridge '${BRIDGE_NAME}' is up"
    else
      fail "Bridge '${BRIDGE_NAME}' is not up (flags: ${BRIDGE_FLAGS})"
      warn "  Fix: sudo ip link set ${BRIDGE_NAME} up"
    fi
    # Check for assigned IP
    BRIDGE_IP=$(ip -4 addr show "${BRIDGE_NAME}" 2>/dev/null | grep -oP 'inet \K[\d./]+' || true)
    if [ -n "${BRIDGE_IP}" ]; then
      pass "Bridge '${BRIDGE_NAME}' has IP: ${BRIDGE_IP}"
    else
      fail "Bridge '${BRIDGE_NAME}' has no IPv4 address assigned"
      warn "  Fix: sudo ip addr add 10.0.0.1/24 dev ${BRIDGE_NAME}"
    fi
  else
    fail "Bridge interface '${BRIDGE_NAME}' not found"
    warn "  Run: kici-admin firecracker provision --bridge ${BRIDGE_NAME} --cidr 10.0.0.1/24 to create it"
  fi

  echo ""
fi

# ── Check 7: IP forwarding ────────────────────────────────────────────────

echo -e "${BOLD}Kernel Configuration${NC}"

IP_FORWARD=$(cat /proc/sys/net/ipv4/ip_forward 2>/dev/null || echo "0")
if [ "${IP_FORWARD}" = "1" ]; then
  pass "IPv4 forwarding is enabled"
else
  fail "IPv4 forwarding is disabled"
  warn "  Temporary fix: sudo sysctl -w net.ipv4.ip_forward=1"
  warn "  Persistent fix: echo 'net.ipv4.ip_forward = 1' | sudo tee /etc/sysctl.d/99-kici-forward.conf"
fi

echo ""

# ── Summary ────────────────────────────────────────────────────────────────

echo -e "${BOLD}Summary${NC}"
echo ""

if [ "${FAILED}" -eq 0 ]; then
  echo -e "  ${GREEN}${BOLD}ALL CHECKS PASSED${NC}"
  echo ""
  echo "  Your host is ready for Firecracker microVMs with KiCI."
  if [ "${ARCH}" = "aarch64" ]; then
    info "Note: On arm64, use the PE kernel format (Image), not vmlinux"
    info "Note: SendCtrlAltDel is not available on arm64 -- VMs use process kill for shutdown"
  fi
  exit 0
else
  echo -e "  ${RED}${BOLD}SOME CHECKS FAILED${NC}"
  echo ""
  echo "  Please fix the issues above before running Firecracker VMs."
  echo "  Refer to: https://github.com/firecracker-microvm/firecracker/blob/main/docs/prod-host-setup.md"
  exit 1
fi
