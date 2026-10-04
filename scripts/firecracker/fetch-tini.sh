#!/usr/bin/env bash
# scripts/firecracker/fetch-tini.sh
#
# Fetches the static tini that runs as PID 1 in every Firecracker agent VM, and
# verifies it against the SHA-256 pinned below. The release assets are also
# GPG-signed by the tini maintainer: the pins come from verified downloads.
#
# Usage: fetch-tini.sh <x86_64|aarch64> <dest>
#
# <dest> doubles as a cache: a file there that matches the pin is kept, so a
# refresh needs no network. Anything else is replaced by a fresh download,
# written beside <dest> and moved into place only once it verifies.
#
# Environment:
#   KICI_TINI_BASE_URL  Where the release assets are served (default: the tini
#                       GitHub releases). A mirror must serve the same files:
#                       the pinned SHA-256 decides either way.
set -euo pipefail

TINI_VERSION="0.19.0"
TINI_SHA256_X86_64="c5b0666b4cb676901f90dfcb37106783c5fe2077b04590973b885950611b30ee"
TINI_SHA256_AARCH64="eae1d3aa50c48fb23b8cbdf4e369d0910dfc538566bfd09df89a774aa84a48b9"

ARCH="${1:?usage: fetch-tini.sh <x86_64|aarch64> <dest>}"
DEST="${2:?usage: fetch-tini.sh <x86_64|aarch64> <dest>}"

case "$ARCH" in
  x86_64) ASSET="tini-static-amd64"; SHA256="$TINI_SHA256_X86_64" ;;
  aarch64) ASSET="tini-static-arm64"; SHA256="$TINI_SHA256_AARCH64" ;;
  *) echo "fetch-tini: unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

matches() { [ -f "$1" ] && [ "$(sha256sum "$1" | cut -d' ' -f1)" = "$SHA256" ]; }

if matches "$DEST"; then
  chmod 755 "$DEST"
  echo "fetch-tini: $DEST already holds tini v${TINI_VERSION} (${ARCH})"
  exit 0
fi

URL="${KICI_TINI_BASE_URL:-https://github.com/krallin/tini/releases/download}"
URL="${URL%/}/v${TINI_VERSION}/${ASSET}"
mkdir -p "$(dirname "$DEST")"
TMP="$(mktemp "${DEST}.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors -o "$TMP" "$URL"
if ! matches "$TMP"; then
  echo "fetch-tini: $URL does not match the pinned SHA-256 $SHA256" \
    "(got $(sha256sum "$TMP" | cut -d' ' -f1))" >&2
  exit 1
fi
chmod 755 "$TMP"
mv -f "$TMP" "$DEST"
trap - EXIT
echo "fetch-tini: fetched tini v${TINI_VERSION} (${ARCH}) to $DEST"
