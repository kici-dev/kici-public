#!/bin/sh
# /init -- PID 1 inside Firecracker VM
# Networking is configured by the kernel via boot_args (ip=...).
#
# build-agent-rootfs.sh installs this file as /init on every agent injection,
# so it always matches the MMDS keys the orchestrator writes.
#
# Supports two modes:
# - Overlay mode (default): rootfs is read-only, /dev/vdb provides a writable
#   overlay via overlayfs. Enables CoW — the base rootfs is hardlinked (shared)
#   across all VMs instead of being copied per VM.
# - Legacy mode: rootfs is read-write (no overlay drive). Backward compatible
#   with older Firecracker configs that don't include an overlay drive.

# Mount devtmpfs first so /dev/vdb is visible for the overlay check.
# The kernel may or may not auto-mount devtmpfs depending on CONFIG_DEVTMPFS_MOUNT.
mount -t devtmpfs devtmpfs /dev 2>/dev/null || true

# Route init log lines through /dev/kmsg (the kernel printk interface) instead
# of relying on plain stdout. Firecracker's stdout is block-buffered when
# redirected to a file FD (as the orchestrator does for serial-console.log),
# so sparse userspace writes sit in the buffer and never reach the file until
# Firecracker exits — which means the orchestrator's tail aborts before the
# buffered data is flushed. Kernel printk bypasses that entirely: the kernel
# console driver writes to ttyS0 synchronously, so `echo … > /dev/kmsg`
# surfaces in serial-console.log within milliseconds. We still echo to stdout
# as a backup (harmless, visible in `virsh console` / `firecracker --console`
# interactive sessions that don't redirect stdout).
log() {
  echo "[init] $*" > /dev/kmsg 2>/dev/null || true
  echo "[init] $*"
}

# Append the scaler's `extraHosts` to the hosts file $2. $1 is the MMDS
# `kici-extra-hosts` value: `host:address` pairs joined by commas, where the
# host ends at the first colon so an IPv6 address keeps its own colons. The
# orchestrator validates every entry and resolves `host-gateway` before it
# writes the value. Empty when the scaler maps no host: a guest carries no
# mapping its operator did not configure.
add_extra_hosts() {
  [ -n "$1" ] || return 0
  printf '%s\n' "$1" | tr ',' '\n' | while IFS= read -r ENTRY; do
    case "$ENTRY" in
      [!:]*:?*) ;;
      *) continue ;;
    esac
    printf '%s %s\n' "${ENTRY#*:}" "${ENTRY%%:*}" >> "$2"
    log "Added ${ENTRY%%:*} -> ${ENTRY#*:} to $2"
  done
}

if [ -b /dev/vdb ]; then
  # ── Overlay mode: rootfs is read-only, use overlayfs for writes ──
  mount -t proc proc /proc
  mount -t sysfs sysfs /sys
  mount -t tmpfs tmpfs /tmp

  # Mount the pre-formatted overlay drive
  mkdir -p /tmp/overlay
  mount /dev/vdb /tmp/overlay 2>/dev/null || {
    log "Formatting overlay drive..."
    mkfs.ext4 -qF /dev/vdb 2>/dev/null
    mount /dev/vdb /tmp/overlay
  }
  mkdir -p /tmp/overlay/upper /tmp/overlay/work /tmp/merged

  # Create overlayfs: read-only rootfs as lower, overlay drive as upper
  mount -t overlay overlay \
    -o lowerdir=/,upperdir=/tmp/overlay/upper,workdir=/tmp/overlay/work \
    /tmp/merged

  # Move virtual filesystems into the merged root
  mount --move /proc /tmp/merged/proc
  mount --move /sys /tmp/merged/sys
  mount --move /dev /tmp/merged/dev

  # Switch to the overlayed root. PID 1 exiting stops the VM, which beats
  # pivoting whatever directory a failed cd left us in.
  cd /tmp/merged || exit 1
  pivot_root . mnt
  mount -t tmpfs tmpfs /tmp

  log "Overlay mode active (rootfs read-only + overlay drive)"
else
  # ── Legacy mode: rootfs is read-write (no overlay drive) ──
  mount -t proc proc /proc
  mount -t sysfs sysfs /sys
  mount -t devtmpfs devtmpfs /dev
fi

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export HOME="/root"
export SHELL="/bin/bash"

echo "nameserver 8.8.8.8" > /etc/resolv.conf
echo "nameserver 1.1.1.1" >> /etc/resolv.conf

MMDS_ADDR="169.254.169.254"
MAX_RETRIES=30
RETRIES=0

log "Waiting for MMDS..."
while [ "$RETRIES" -lt "$MAX_RETRIES" ]; do
  TOKEN=$(curl -sf -X PUT "http://${MMDS_ADDR}/latest/api/token" \
    -H "X-metadata-token-ttl-seconds: 300" 2>/dev/null || echo "")
  if [ -n "$TOKEN" ]; then
    log "MMDS available"
    break
  fi
  RETRIES=$((RETRIES + 1))
  sleep 1
done

if [ -n "$TOKEN" ]; then
  KICI_ORCHESTRATOR_URL=$(curl -sf -H "X-metadata-token: $TOKEN" \
    "http://${MMDS_ADDR}/latest/meta-data/kici-orchestrator-url" || echo "")
  KICI_AGENT_ID=$(curl -sf -H "X-metadata-token: $TOKEN" \
    "http://${MMDS_ADDR}/latest/meta-data/kici-agent-id" || echo "")
  KICI_LABELS=$(curl -sf -H "X-metadata-token: $TOKEN" \
    "http://${MMDS_ADDR}/latest/meta-data/kici-labels" || echo "")
  KICI_SCALER_MANAGED=$(curl -sf -H "X-metadata-token: $TOKEN" \
    "http://${MMDS_ADDR}/latest/meta-data/kici-scaler-managed" || echo "1")
  KICI_AGENT_TOKEN=$(curl -sf -H "X-metadata-token: $TOKEN" \
    "http://${MMDS_ADDR}/latest/meta-data/kici-agent-token" || echo "")
  KICI_EXTRA_HOSTS=$(curl -sf -H "X-metadata-token: $TOKEN" \
    "http://${MMDS_ADDR}/latest/meta-data/kici-extra-hosts" || echo "")
else
  log "WARNING: MMDS not available after ${MAX_RETRIES} retries"
  KICI_ORCHESTRATOR_URL=""
  KICI_AGENT_ID=""
  KICI_LABELS=""
  KICI_SCALER_MANAGED="1"
  KICI_AGENT_TOKEN=""
  KICI_EXTRA_HOSTS=""
fi

add_extra_hosts "$KICI_EXTRA_HOSTS" /etc/hosts

# Operator-defined env forwarding (KICI_AGENT_ENV_* on the orchestrator + scalers.yaml env:).
# MMDS exposes them under meta-data/kici-env/ as a directory; list keys then GET each value.
# Keys were already validated POSIX-safe by the orchestrator. Pure POSIX sh: write each
# `export KEY='value'` to a temp file inside the pipe-spawned subshell, then `.` (source)
# the file in the parent shell so the exports survive. Single-quote escaping uses the
# standard '\\'' close-escape-reopen trick to handle values containing single quotes.
if [ -n "$TOKEN" ]; then
  KICI_ENV_KEYS=$(curl -sf -H "X-metadata-token: $TOKEN" \
    "http://${MMDS_ADDR}/latest/meta-data/kici-env/" 2>/dev/null || echo "")
  if [ -n "$KICI_ENV_KEYS" ]; then
    KICI_ENV_TMP=$(mktemp)
    echo "$KICI_ENV_KEYS" | while IFS= read -r KEY; do
      [ -z "$KEY" ] && continue
      VALUE=$(curl -sf -H "X-metadata-token: $TOKEN" \
        "http://${MMDS_ADDR}/latest/meta-data/kici-env/${KEY}" 2>/dev/null || echo "")
      ESCAPED=$(printf '%s' "$VALUE" | sed "s/'/'\\\\''/g")
      printf "export %s='%s'\n" "$KEY" "$ESCAPED" >> "$KICI_ENV_TMP"
    done
    if [ -s "$KICI_ENV_TMP" ]; then
      # shellcheck source=/dev/null  # written just above from MMDS
      . "$KICI_ENV_TMP"
      KICI_ENV_COUNT=$(wc -l < "$KICI_ENV_TMP" | tr -d ' ')
      log "Applied ${KICI_ENV_COUNT} forwarded env var(s) from MMDS"
    fi
    rm -f "$KICI_ENV_TMP"
  fi
fi

export KICI_ORCHESTRATOR_URL
export KICI_SCALER_MANAGED
if [ -n "$KICI_AGENT_ID" ]; then export KICI_AGENT_ID; fi
if [ -n "$KICI_LABELS" ]; then export KICI_LABELS; fi
if [ -n "$KICI_AGENT_TOKEN" ]; then export KICI_AGENT_TOKEN; fi

log "KICI_ORCHESTRATOR_URL=$KICI_ORCHESTRATOR_URL"
log "KICI_AGENT_ID=$KICI_AGENT_ID"
log "KICI_LABELS=$KICI_LABELS"
log "KICI_SCALER_MANAGED=$KICI_SCALER_MANAGED"
log "KICI_AGENT_TOKEN=${KICI_AGENT_TOKEN:+set (redacted)}"

# /proc/meminfo, not `free`: this rootfs carries no procps, so every `free`
# call printed "free: not found" to the console and left the figure empty —
# the memory reading was absent from every VM's log, on both this snapshot and
# the monitor tick below.
mem_line() {
  awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{
    if (t) printf "used=%dM total=%dM avail=%dM", (t-a)/1024, t/1024, a/1024
    else printf "unavailable"
  }' /proc/meminfo 2>/dev/null || echo "unavailable"
}

log "=== Resource Snapshot ==="
log "Memory: $(mem_line)"
log "Disk: $(df -h / | awk 'NR==2{printf "used=%s size=%s avail=%s use%%=%s", $3, $2, $4, $5}')"
log "========================="

(
  # Backgrounded subshell inherits log() from the parent via dash's fork-without-
  # exec, so we can reuse the same /dev/kmsg routing here. Switch the prefix to
  # [monitor] manually since log() hardcodes [init].
  mon() {
    echo "[monitor] $*" > /dev/kmsg 2>/dev/null || true
    echo "[monitor] $*"
  }
  while true; do
    MEM_INFO=$(mem_line)
    set -- /proc/[0-9]*
    PROC_COUNT=$#
    # Exclude this monitor's own lines before counting. Each tick writes
    # "OOM_EVENTS:<n>" to /dev/kmsg, which lands in dmesg and matches the very
    # pattern below — so the unfiltered count rose by exactly one per tick and
    # reported a fabricated OOM storm on a VM that had never OOMed once.
    OOM=$(dmesg 2>/dev/null | grep -v "\[monitor\]" \
      | grep -ic "oom\|out of memory\|killed process" || echo "0")
    mon "$(date +%H:%M:%S) MEM:${MEM_INFO} PROCS:${PROC_COUNT} OOM_EVENTS:${OOM}"
    sleep 10
  done
) &

log "Starting KiCI agent..."
exec /usr/local/bin/node /opt/kici/agent.js
