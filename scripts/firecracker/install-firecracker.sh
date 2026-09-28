#!/bin/bash
# Canonical Firecracker + jailer installer — the single source of truth for the
# pinned Firecracker version. Downloads the release tarball from GitHub, installs
# the firecracker + jailer binaries to /usr/local/bin, and re-applies the jailer
# file capabilities (cleared whenever the binary is replaced).
#
# FC_VERSION below is the Firecracker release this KiCI release is tested with.
# To change it, bump it here and re-run this script on every Firecracker host.
#
#   sudo bash scripts/firecracker/install-firecracker.sh
#
# Idempotent: a host already on the pinned version only re-applies setcap.
set -euo pipefail

FC_VERSION="1.17.0"

ARCH="$(uname -m)"
WANT="Firecracker v${FC_VERSION}"
HAVE="$(/usr/local/bin/firecracker --version 2>/dev/null | head -1 || true)"

if [ "$HAVE" != "$WANT" ]; then
  echo "Installing Firecracker v${FC_VERSION} (${ARCH})..."
  tmp="$(mktemp -d -t kici-fc-XXXXXX)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL \
    "https://github.com/firecracker-microvm/firecracker/releases/download/v${FC_VERSION}/firecracker-v${FC_VERSION}-${ARCH}.tgz" \
    | tar -xz -C "$tmp"
  install -m 755 "${tmp}/release-v${FC_VERSION}-${ARCH}/firecracker-v${FC_VERSION}-${ARCH}" /usr/local/bin/firecracker
  install -m 755 "${tmp}/release-v${FC_VERSION}-${ARCH}/jailer-v${FC_VERSION}-${ARCH}" /usr/local/bin/jailer
else
  echo "Firecracker already at v${FC_VERSION}; re-applying jailer capabilities."
fi

# File capabilities are cleared when the binary is replaced — always (re)apply.
setcap 'cap_sys_chroot,cap_setuid,cap_setgid+ep' /usr/local/bin/jailer

echo "firecracker: $(/usr/local/bin/firecracker --version | head -1)"
echo "jailer:      $(/usr/local/bin/jailer --version | head -1)"
echo "jailer caps: $(getcap /usr/local/bin/jailer)"
